# evidence —— 空

每次验证运行按 RUN.<UTC时间戳>.<8位hex>/ 建目录，放原始结果 + manifest。
初始化时没有任何运行，**不放占位文件**（占位文件会让「无证据」看起来像「有证据」）。

证据绑定：spec/source/artifact/sbom/env/verifier/challenge/policy 的 digest；
任一变化 → 旧证据 INVALID，从最早变化点重跑。**不得重跑到绿掩盖反例。**
