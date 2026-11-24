#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ocr_server.py —— cx-exam-helper 图片题 OCR 兜底服务

常驻 RapidOCR（中文），供 Node 端 answer-server 在 a11y 读不到题干时调用。
只依赖标准库 + rapidocr_onnxruntime（已装）。

启动：python ocr_server.py        （默认 127.0.0.1:18890）
端点：
  GET  /health          → {ok, engine, ready}
  POST /ocr             → {text, lines}   body: {"image":"<base64 png/jpg>"}
                           或 body: {"path":"<本地文件路径>"}（调试用）
  POST /ocr/file        → 同上，multipart 不用；走 path 字段即可

设计：
  - RapidOCR 只初始化一次（~0.5s），之后每次识别 ~4s（CPU）
  - 识别结果按 y 坐标排序后拼接成整屏文字，交给 answer-core 清洗
  - 置信度阈值 0.5，滤掉低质量碎片
  - 返回纯文本，Node 端把它当 a11y 文本走同一条 parseScreen 管线
"""
import base64
import io
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("OCR_PORT", "18890"))
MIN_SCORE = float(os.environ.get("OCR_MIN_SCORE", "0.5"))

_ocr = None


def get_ocr():
    global _ocr
    if _ocr is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr = RapidOCR()
    return _ocr


def recognize(data: bytes):
    """bytes → (整屏文本, 行列表)"""
    ocr = get_ocr()
    # RapidOCR 接受 numpy 数组 / 文件路径 / bytes 路径；用临时文件最稳
    fd, path = tempfile.mkstemp(suffix=".png")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        res, _ = ocr(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    lines = []
    if res:
        # res: [[box, text, score], ...]，按 y 坐标排序（从上到下）
        items = []
        for box, text, score in res:
            try:
                sc = float(score)
            except (TypeError, ValueError):
                sc = 0.0
            if sc < MIN_SCORE or not text:
                continue
            y = min(p[1] for p in box) if box else 0
            items.append((y, str(text).strip()))
        items.sort(key=lambda x: x[0])
        lines = [t for _, t in items if t]
    return "\n".join(lines), lines


class Handler(BaseHTTPRequestHandler):
    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", "0"))
        if n <= 0 or n > 20 * 1024 * 1024:
            return b""
        return self.rfile.read(n)

    def do_GET(self):
        if self.path.startswith("/health"):
            ok = True
            err = ""
            try:
                get_ocr()
            except Exception as e:
                ok, err = False, str(e)
            self._send({"ok": ok, "engine": "rapidocr_onnxruntime", "ready": ok, "error": err},
                       200 if ok else 503)
        else:
            self._send({"error": "not found"}, 404)

    def do_POST(self):
        if self.path not in ("/ocr", "/ocr/file"):
            return self._send({"error": "not found"}, 404)
        try:
            body = json.loads(self._read_body().decode("utf-8", "replace") or "{}")
            if "image" in body:
                data = base64.b64decode(body["image"])
            elif "path" in body:
                with open(body["path"], "rb") as f:
                    data = f.read()
            else:
                return self._send({"error": "need image or path"}, 400)
            text, lines = recognize(data)
            self._send({"ok": True, "text": text, "lines": lines, "count": len(lines)})
        except Exception as e:
            self._send({"ok": False, "error": str(e)}, 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("[ocr] " + (fmt % args) + "\n")


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"OCR server on http://127.0.0.1:{PORT}", flush=True)
    srv.serve_forever()
