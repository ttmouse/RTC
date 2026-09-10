#!/usr/bin/env python3
"""
本地 SenseVoice ASR 服务 — RTC 第三种引擎
能量 VAD + 一次 final 推理（无 interim 中间态）
"""

import asyncio
import json
import os
import re
import uuid

import time
from collections import deque

import numpy as np
import websockets
import sherpa_onnx as _sherpa_onnx

# ---------- 配置 ----------
PORT = int(os.environ.get("ASR_PORT", "8932"))
ENGINE = os.environ.get("ASR_ENGINE", "sensevoice")   # sensevoice | qwen3
QWEN3_DIR = os.environ.get("ASR_QWEN3_DIR") or os.path.join(os.path.dirname(__file__), "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25")
NUM_THREADS = int(os.environ.get("ASR_NUM_THREADS", "4"))
# 首次使用时的模型下载地址（GitHub Releases 资产；发布时随版本上传）
MODEL_DOWNLOAD_URL = os.environ.get(
    "ASR_MODEL_DOWNLOAD_URL",
    "https://github.com/ttmouse/RTC/releases/latest/download/official_sensevoice.zip",
)


def default_qwen3_dir() -> str:
    """Qwen3 模型目录探测顺序：环境变量 > server.py 同目录（dev 模式）> 约定目录（.app 外置模型）。

    .app 内置版不带 Qwen3 模型，约定目录为
    ~/Library/Application Support/com.rtc.transcriber/models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25
    """
    if os.environ.get("ASR_QWEN3_DIR"):
        return os.environ["ASR_QWEN3_DIR"]
    same_dir = os.path.join(os.path.dirname(__file__), "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25")
    if os.path.isdir(same_dir):
        return same_dir
    convention = os.path.join(
        os.path.expanduser("~"), "Library", "Application Support",
        "com.rtc.transcriber", "models", "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
    )
    if os.path.isdir(convention):
        return convention
    return same_dir


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
        print(f"[asr_local] 模型下载失败: {e}（请联网后重启应用，或手动将模型放到 {model_dir}）")
        raise


MODEL_DIR, _MODEL_DOWNLOADED = ensure_sensevoice_model()
MODEL_PATH = os.path.join(MODEL_DIR, "model.int8.onnx")
TOKENS_PATH = os.path.join(MODEL_DIR, "tokens.txt")

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
            print(f"[asr_local] 加载 SenseVoice 模型: {MODEL_PATH}")
            return _sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=MODEL_PATH,
                tokens=TOKENS_PATH,
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
                "请将模型放到该目录，或在本应用「设置」里指定 Qwen3 模型目录。"
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
    def _infer(rec, audio: np.ndarray) -> str:
        stream = rec.create_stream()
        stream.accept_waveform(16000, audio)
        rec.decode_stream(stream)
        return stream.result.text.strip()


class LocalASR:
    """SherpaONNX 推理封装 — 兼容旧接口（单引擎，启动即加载）"""

    def __init__(self, engine: str = ENGINE):
        self.engine = engine
        t0 = time.time()
        import concurrent.futures
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.rec = None
        self._engine_build(engine)
        print(f"[asr_local] 模型就绪 ({time.time()-t0:.1f}s) [{engine}]")

    def _engine_build(self, engine: str):
        if engine == "qwen3":
            print(f"[asr_local] 加载 Qwen3-ASR 模型: {QWEN3_DIR}")
            self.rec = _sherpa_onnx.OfflineRecognizer.from_qwen3_asr(
                conv_frontend=str(os.path.join(QWEN3_DIR, "conv_frontend.onnx")),
                encoder=str(os.path.join(QWEN3_DIR, "encoder.int8.onnx")),
                decoder=str(os.path.join(QWEN3_DIR, "decoder.int8.onnx")),
                tokenizer=str(os.path.join(QWEN3_DIR, "tokenizer")),
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
            print(f"[asr_local] 加载 SenseVoice 模型: {MODEL_PATH}")
            self.rec = _sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=MODEL_PATH,
                tokens=TOKENS_PATH,
                use_itn=True,
                debug=False,
                num_threads=NUM_THREADS,
            )

    async def recognize(self, pcm: bytes) -> str:
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        if len(audio) == 0:
            return ""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self.executor, self._infer, audio)

    def _infer(self, audio: np.ndarray) -> str:
        stream = self.rec.create_stream()
        stream.accept_waveform(16000, audio)
        self.rec.decode_stream(stream)
        text = stream.result.text
        return text.strip()


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


async def main():
    # 启动时预热默认引擎（缓存里最后选的那个），端口监听前完成
    await engine_mgr.load(ENGINE)
    async with websockets.serve(handle, "127.0.0.1", PORT, max_size=10 * 1024 * 1024):
        print(f"[asr_local] 监听 ws://127.0.0.1:{PORT} (引擎: {ENGINE}, 支持热切换 sensevoice/qwen3)")
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[asr_local] 退出")
