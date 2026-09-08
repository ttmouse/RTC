#!/usr/bin/env node
/**
 * zsx-rtc 风格后端服务器
 * 端口 8931：HTTP 服务（前端页面）+ WebSocket 代理（引擎分流）
 *
 * 浏览器 → ws://localhost:8931 → 本服务器 → 上游引擎
 *                                      ├─ engine=bailian → wss://dashscope（百炼 ASR，过滤中间帧）
 *                                      └─ engine=local   → ws://127.0.0.1:8932（本地 SenseVoice，全转发）
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// ========== HTTP 服务（前端页面） ==========

const PORT = Number(process.env.PORT || 8931);
const TIMING_LOGS = process.env.ASR_TIMING_LOGS === '1' || process.env.RTC_TIMING_LOGS === '1';
const DATA_ROOT = process.env.RTC_DATA_DIR || path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'rtc-transcriber'
);
const EVENTS_DIR = path.join(DATA_ROOT, 'events');
const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const SCHEMA_VERSION = 1;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function localDateStamp(input) {
  const d = input instanceof Date ? input : new Date(input);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function appendTranscriptEvent(event, callback) {
  fs.mkdir(EVENTS_DIR, { recursive: true }, (mkdirErr) => {
    if (mkdirErr) {
      callback(mkdirErr);
      return;
    }
    const fileName = `${localDateStamp(event.ts)}.jsonl`;
    fs.appendFile(
      path.join(EVENTS_DIR, fileName),
      JSON.stringify(event) + '\n',
      callback
    );
  });
}

function readJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 1024 * 1024) {
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (e) {
      callback(e);
    }
  });
}

const server = http.createServer((req, res) => {
  // 允许 Tauri webview（tauri:// 协议）回退调用本机 HTTP 服务
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /api/config — 读取本地配置
  if (req.method === 'GET' && req.url === '/api/config') {
    fs.readFile(CONFIG_PATH, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // PUT /api/config — 写入本地配置
  if (req.method === 'PUT' && req.url === '/api/config') {
    readJsonBody(req, (err, parsed) => {
      if (err || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid config' }));
        return;
      }
      fs.mkdir(DATA_ROOT, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: mkdirErr.message }));
          return;
        }
        fs.writeFile(CONFIG_PATH, JSON.stringify(parsed, null, 2), 'utf-8', (writeErr) => {
          if (writeErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: writeErr.message }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });
    });
    return;
  }

  // POST /api/transcripts/events — 追加结构化本地事件
  if (req.method === 'POST' && req.url === '/api/transcripts/events') {
    readJsonBody(req, (err, parsed) => {
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }
      const incoming = parsed.event || parsed;
      const text = typeof incoming.text === 'string' ? incoming.text.trim() : '';
      if (incoming.type !== 'segment' || !text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'event.type=segment and text are required' }));
        return;
      }
      const ts = incoming.ts ? new Date(incoming.ts) : new Date();
      if (!Number.isFinite(ts.getTime())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid ts' }));
        return;
      }
      const event = {
        schemaVersion: SCHEMA_VERSION,
        eventId: incoming.eventId || crypto.randomUUID(),
        type: 'segment',
        text,
        ts: ts.toISOString(),
        engine: incoming.engine || null,
      };
      appendTranscriptEvent(event, (writeErr) => {
        if (writeErr) {
          console.error('[transcript] append failed:', writeErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: writeErr.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, event }));
      });
    });
    return;
  }

  // GET /api/transcripts/events — 读取事件；支持 ?date=YYYY-MM-DD 或 ?from&to
  if (req.method === 'GET' && req.url.startsWith('/api/transcripts/events')) {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const date = url.searchParams.get('date');
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');

    const parseEvents = data => data
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    const sendEvents = events => {
      events.sort((a, b) => new Date(a.ts) - new Date(b.ts));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events));
    };

    const readDateFile = requestedDate => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid date' }));
        return;
      }
      fs.readFile(path.join(EVENTS_DIR, `${requestedDate}.jsonl`), 'utf-8', (readErr, data) => {
        sendEvents(readErr ? [] : parseEvents(data));
      });
    };

    if (date) {
      readDateFile(date);
      return;
    }

    if (!fromParam && !toParam) {
      readDateFile(localDateStamp(new Date()));
      return;
    }

    const from = fromParam ? Date.parse(fromParam) : NaN;
    const to = toParam ? Date.parse(toParam) : Infinity;
    if ((fromParam && !Number.isFinite(from)) || (toParam && !Number.isFinite(to))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid from/to' }));
      return;
    }

    fs.readdir(EVENTS_DIR, (readErr, files) => {
      if (readErr) {
        sendEvents([]);
        return;
      }
      const jsonlFiles = files.filter(file => file.endsWith('.jsonl'));
      let pending = jsonlFiles.length;
      const allEvents = [];
      if (pending === 0) {
        sendEvents([]);
        return;
      }
      for (const file of jsonlFiles) {
        fs.readFile(path.join(EVENTS_DIR, file), 'utf-8', (fileErr, data) => {
          if (!fileErr) allEvents.push(...parseEvents(data));
          pending -= 1;
          if (pending === 0) {
            sendEvents(allEvents.filter(event => {
              const ts = Date.parse(event.ts);
              return ts >= from && ts <= to;
            }));
          }
        });
      }
    });
    return;
  }

  // DELETE /api/transcripts/events — 清空本地事件文件
  if (req.method === 'DELETE' && req.url === '/api/transcripts/events') {
    fs.rm(EVENTS_DIR, { recursive: true, force: true }, (rmErr) => {
      if (rmErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: rmErr.message }));
        return;
      }
      fs.mkdir(EVENTS_DIR, { recursive: true }, (mkdirErr) => {
        if (mkdirErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: mkdirErr.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // GET /api/settings — 读取本地配置文件
  if (req.method === 'GET' && req.url === '/api/settings') {
    const settingsPath = path.join(__dirname, 'settings.json');
    fs.readFile(settingsPath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // POST /api/settings — 保存设置到本地配置文件
  if (req.method === 'POST' && req.url === '/api/settings') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const settingsPath = path.join(__dirname, 'settings.json');
      fs.writeFile(settingsPath, body, 'utf-8', (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        console.log('[settings] saved');
      });
    });
    return;
  }

  // GET /api/history — 读取本地历史记录
  if (req.method === 'GET' && req.url === '/api/history') {
    const historyPath = path.join(__dirname, 'history.json');
    fs.readFile(historyPath, 'utf-8', (err, data) => {
      if (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    });
    return;
  }

  // POST /api/history — 保存/追加历史记录
  if (req.method === 'POST' && req.url === '/api/history') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const historyPath = path.join(__dirname, 'history.json');
      fs.writeFile(historyPath, body, 'utf-8', (err) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    return;
  }

  // DELETE /api/history — 清空历史记录
  if (req.method === 'DELETE' && req.url === '/api/history') {
    const historyPath = path.join(__dirname, 'history.json');
    fs.writeFile(historyPath, '[]', 'utf-8', (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      console.log('[history] cleared');
    });
    return;
  }

  // POST /paste — 服务端 pbcopy + osascript 模拟粘贴
  if (req.method === 'POST' && req.url === '/paste') {
    let body = '';
    let startedAt = Date.now();
    let done = false;
    const respond = (code, data) => {
      if (done) return;
      done = true;
      try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } catch (e) {}
    };
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      startedAt = Date.now();
      let text, autoEnter = false;
      try {
        const parsed = JSON.parse(body);
        text = (parsed.text || '').slice(0, 5000);
        autoEnter = !!parsed.autoEnter;
      } catch (e) {
        text = body.slice(0, 5000);
      }
      // 1) pbcopy 把文本写入剪贴板
      const pbcpy = spawn('pbcopy', [], {
        timeout: 2000,
        env: { ...process.env, LC_ALL: 'en_US.UTF-8' }
      });
      pbcpy.stdin.write(text);
      pbcpy.stdin.end();
      pbcpy.on('close', () => {
        if (TIMING_LOGS) console.log(`[timing-node] paste.pbcopy ${Date.now() - startedAt}ms textLen=${text.length}`);
        // pbcopy 已成功设置剪贴板，光标位置已可用
        // 2) osascript 模拟 Cmd+V 粘贴（可能因辅助功能权限失败，但剪贴板已设置）
        let cmd;
        if (autoEnter) {
          cmd = 'tell application "System Events"\n  keystroke "v" using command down\n  delay 0.3\n  keystroke return\nend tell';
        } else {
          cmd = 'tell application "System Events" to keystroke "v" using command down';
        }
        const as = spawn('osascript', ['-e', cmd], {
          timeout: 2000,
          env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
        });
        as.on('exit', (code) => {
          if (TIMING_LOGS) console.log(`[timing-node] paste.osascript ${Date.now() - startedAt}ms code=${code}`);
          if (code === 0) {
            console.log('[paste] 成功' + (autoEnter ? ' + 回车' : '') + ':', text.slice(0, 40));
            respond(200, { ok: true });
          } else {
            // pbcopy 已写入剪贴板，osascript 失败不影响复制结果
            // 常见原因：进程未获得 macOS 辅助功能权限（仅影响自动粘贴，不影响剪贴板）
            console.warn('[paste] pbcopy 已写入剪贴板，但 osascript 自动粘贴失败 (exit:', code, ')— 用户可手动 Cmd+V');
            respond(200, { ok: true, warn: 'auto_paste_disabled', message: '已复制到剪贴板，请手动粘贴 (Cmd+V)' });
          }
        });
        as.on('error', (e) => {
          if (TIMING_LOGS) console.log(`[timing-node] paste.osascript_error ${Date.now() - startedAt}ms`);
          // osascript 启动失败，但 pbcopy 已写入剪贴板
          console.warn('[paste] pbcopy 已写入剪贴板，但 osascript 无法启动:', e.message);
          respond(200, { ok: true, warn: 'auto_paste_disabled', message: '已复制到剪贴板，请手动粘贴 (Cmd+V)' });
        });
      });
      pbcpy.on('error', (e) => {
        console.error('[paste] pbcopy 失败:', e.message);
        respond(500, { ok: false, error: e.message });
      });
    });
    req.on('error', () => respond(500, { ok: false, error: 'request error' }));
    return;
  }

  const filePath = req.url === '/' ? '/index.html' : req.url;
  const fullPath = path.join(__dirname, filePath);

  if (!fullPath.startsWith(__dirname)) {
    res.writeHead(403); res.end();
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(data);
  });
});

// ========== WebSocket 代理（引擎分流） ==========

const LOCAL_ASR_URL = process.env.LOCAL_ASR_URL || 'ws://127.0.0.1:8932';

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let upstream = null;
  let engine = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (upstream) {
      try { upstream.close(); } catch (e) {}
      upstream = null;
    }
    try { ws.close(); } catch (e) {}
  };

  // 第一步：等待浏览器发送 connect 消息
  ws.once('message', async (data) => {
    let connectMsg;
    try {
      connectMsg = JSON.parse(data);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid connect message' }));
      return close();
    }

    if (connectMsg.type !== 'connect') {
      ws.send(JSON.stringify({ type: 'error', message: 'expected connect message' }));
      return close();
    }

    engine = connectMsg.engine || 'bailian';
    // 本地类引擎（sensevoice/qwen3 等）统一连本地 Python ASR 服务；bailian 走云端 URL
    const isLocal = engine !== 'bailian';
    const upstreamUrl = isLocal
      ? LOCAL_ASR_URL
      : connectMsg.url; // bailian: wss://dashscope...?api_key=...

    if (!isLocal && !upstreamUrl) {
      ws.send(JSON.stringify({ type: 'error', message: 'missing upstream url' }));
      return close();
    }

    console.log(`[server] engine=${engine} connecting to ${isLocal ? LOCAL_ASR_URL : '百炼'}`);

    // 第二步：连接上游引擎
    try {
      upstream = new WebSocket(upstreamUrl);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: `上游连接失败: ${e.message}` }));
      return close();
    }

    upstream.on('open', () => {
      console.log(`[server] ${engine} connected`);
      ws.send(JSON.stringify({ type: 'connected' }));
    });

    upstream.on('error', (err) => {
      console.log(`[server] ${engine} error:`, err.message);
      ws.send(JSON.stringify({ type: 'error', message: `${isLocal ? '本地ASR' : '百炼'}错误: ${err.message}` }));
      close();
    });

    upstream.on('close', () => {
      console.log(`[server] ${engine} disconnected`);
      close();
    });

    // 第三步：上游 → 浏览器
    upstream.on('message', (upData) => {
      if (closed) return;

      // 统一转为字符串（上游返回的可能是二进制帧，浏览器收到 Blob 后 JSON.parse 会失败）
      const text = typeof upData === 'string' ? upData : upData.toString('utf-8');

      try {
        const parsed = JSON.parse(text);
        const event = parsed.header && parsed.header.event;

        if (event === 'result-generated') {
          const sentence = parsed.payload && parsed.payload.output && parsed.payload.output.sentence;
          const textContent = sentence && sentence.text;

          if (TIMING_LOGS && sentence) {
            const nodeReceivedAt = Date.now();
            if (!sentence.timing) sentence.timing = {};
            sentence.timing.node_received_wall_ms = nodeReceivedAt;
            sentence.timing.node_sent_wall_ms = nodeReceivedAt;
            console.log(`[timing-node] asr_result_received engine=${engine} taskId=${parsed.header.task_id} segId=${sentence.seg_id || ''} textLen=${(textContent || '').length}`);
          }

          if (isLocal) {
            // 本地引擎（sensevoice/qwen3）：Python 端已只发完整句，全转发
            if (textContent) {
              console.log(`[server] ${engine} result: ${textContent.slice(0, 40)}...`);
              ws.send(TIMING_LOGS ? JSON.stringify(parsed) : text);
            }
          } else {
            // 百炼：所有有文本的结果都转发（中间帧用于前端临时行显示，完整句带 end_time 用于定型）
            if (textContent) {
              console.log(`[server] bailian result: ${textContent.slice(0, 40)}...`);
              ws.send(TIMING_LOGS ? JSON.stringify(parsed) : text);
            } else {
              console.log(`[server] skip interim (no text)`);
            }
          }
        } else {
          // 其他事件（task-started, task-finished 等）→ 转发
          console.log(`[server] event=${event}`);
          ws.send(text);
        }
      } catch (e) {
        // 非 JSON 消息，转发
        console.log(`[server] non-json message, forwarding`);
        ws.send(text);
      }
    });

    // 第四步：浏览器 → 上游（原样转发）
    ws.on('message', (browserData, isBinary) => {
      if (closed || !upstream) {
        console.log('[server] drop msg: closed or no upstream');
        return;
      }
      if (upstream.readyState !== WebSocket.OPEN) {
        console.log('[server] drop msg: upstream not open, readyState=' + upstream.readyState);
        return;
      }

      // 二进制帧（PCM 音频）→ 原样转发，必须保持二进制帧类型！
      if (isBinary) {
        upstream.send(browserData, { binary: true });
        return;
      }

      // 文本帧 → 处理 JSON 消息
      const text = typeof browserData === 'string' ? browserData : browserData.toString('utf-8');

      // 跳过 connect 消息（已经处理过了）
      try {
        const parsed = JSON.parse(text);
        if (parsed.type === 'connect') {
          console.log('[server] skip connect msg');
          return;
        }
      } catch (e) {}

      // 发送给上游（字符串 → 文本帧）
      console.log(`[server] forward to ${engine}: ${text.slice(0, 60)}...`);
      try {
        upstream.send(text);
      } catch (e) {
        console.log('[server] upstream.send error:', e.message);
      }
    });

    ws.on('close', close);
    ws.on('error', close);
  });

  // 30 秒超时：如果浏览器没发 connect 消息，断开
  setTimeout(() => {
    if (!upstream) {
      ws.close();
    }
  }, 30000);
});

// 监听 '::' 双栈：同时接受 IPv4 (127.0.0.1) 与 IPv6 (::1) 连接。
// 前端 WebSocket 使用 localhost，在 Tauri WKWebView 中可能解析为 ::1，
// 只绑 0.0.0.0 会导致 WebView 连不上（连接被拒）。
server.listen(PORT, '::', () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`WebSocket proxy at ws://localhost:${PORT}`);
  console.log(`Engines: bailian (cloud) / local (SenseVoice @ ${LOCAL_ASR_URL})`);
});
