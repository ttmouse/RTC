# D-012：打包的 node 后端改为「官方 bun 运行时 + server.bundle.js」

```json
{
  "id": "D-012",
  "kind": "decision",
  "status": "active",
  "summary": "打包用的 node 后端不再用 bun --compile 单文件，改为官方 bun 运行时加资源目录里的 server.bundle.js；前者在 macOS 26+ 被 AMFI 以无 CMS 签名拒载并 SIGKILL",
  "scope": [
    "scripts/build-sidecar.sh",
    "src-tauri/src/lib.rs",
    "src-tauri/tauri.conf.json",
    "src-tauri/binaries"
  ],
  "sources": [
    "docs/evidence/2026-09-20-packaged-app-sidecar.md",
    "scripts/build-sidecar.sh",
    "src-tauri/src/lib.rs",
    "src-tauri/tauri.conf.json",
    "README.md"
  ],
  "relations": [
    {"type": "validated_by", "target": "E-008"}
  ],
  "key": "packaged-node-backend-runtime",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 为什么

`bun build --compile` 的产物只有 linker 签名、没有 CMS blob。macOS 26+ 的 AMFI 在加载时直接
`has no CMS blob? → Unrecoverable CT signature issue → SIGKILL`，进程零输出、不绑端口。
后果是打包版「窗口开得了、历史记录一片空白、界面写服务未连接」——看起来像功能坏了，实际是后端没起来。

该产物事后不可修：`codesign --force --sign -` 报 `main executable failed strict validation`，
`codesign --remove-signature` 报 `internal error in Code Signing subsystem`。最小复现是 hello world
也被 kill，与本仓库代码无关。同一批 sidecar 里 pyinstaller 打的 asr-server 签名有效、能正常跑，
所以现象容易误判成「服务整体没问题」。

## 决定要点

- `node-server` sidecar = bun 官方二进制本体（保留 Apple 公证签名），后端代码由 `server.bundle.js` 承担。
- `start_node_server` 把 bundle 路径作为参数传给 sidecar；找不到 bundle 就不走 sidecar、退回系统 node。
- `tauri.conf.json` 的 `bundle.resources` 必须带 `server.bundle.js` 与 `package.json`（版本号来源）。
- 体积与旧 `--compile` 产物相同（约 60MB），不额外膨胀。

## 边界

- 该方案依赖「Tauri 不重签 sidecar」；将来引入签名身份或公证时，必须重新确认 bun 的签名未被覆盖。
- 只在 macOS 26/27 上验证过拒载行为；旧系统上 `--compile` 是否可用未测，本决定按最保守方式执行。
