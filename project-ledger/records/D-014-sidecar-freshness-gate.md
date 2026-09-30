# D-014：打包前必须证明 sidecar 与源码同源

```json
{
  "id": "D-014",
  "kind": "rule",
  "status": "active",
  "summary": "npm run build（tauri 打包必经）前置 check-sidecar-freshness：任一 sidecar 比 server.js 或 asr_local/server.py 旧即失败并要求先跑 build:sidecar",
  "scope": [
    "scripts/check-sidecar-freshness.mjs",
    "scripts/build-sidecar.sh",
    "package.json",
    "README.md"
  ],
  "sources": [
    "scripts/check-sidecar-freshness.mjs",
    "README.md",
    "docs/product-rules/ux-issue-log.md"
  ],
  "relations": [
    {"type": "related_to", "target": "D-012"},
    {"type": "validated_by", "target": "E-008"}
  ],
  "key": "packaged-sidecar-freshness",
  "recorded_at": "2026-09-20",
  "verified_at": "2026-09-20"
}
```

## 为什么

一次打包里有五个独立产物：前端 `dist/`、`server.bundle.js`、两个 sidecar、Rust 二进制。
没重建的那个不报错，只让打包版的**行为**和源码不一致。2026-09-20 出过一次：
打包用的 asr-server 是 09-15 编译的，不认识 09-20 才加的按住说话协议，
表现成「手没松就自己收尾」——而 dev 模式跑仓库源码，一切正常，最难查的那一类。

## 决定要点

- 判据只有一条：产物 mtime 不早于源文件（1 秒容差），不做内容哈希比较。
- sidecar 缺失只警告不失败：那可能是还没构建的机器，前端构建本身仍可跑；
  真正打包时 Tauri 会因 `externalBin` 缺失自己报错。
- 失败信息必须同时给出「旧产物、源文件、两边时间、下一步命令」。

## 边界

- 门禁只能证明时间关系，不能证明产物是用当前源码编出来的（例如手工 touch 过 mtime）。
- 未覆盖 `src/js`、`src/css`、Rust 源与 `dist/` 的关系；这些由构建流程本身保证。
