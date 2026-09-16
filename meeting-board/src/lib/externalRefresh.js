// 外部改写白板之后，面板要自己变回来。
//
// 移植自 xiaoer-omia（小耳 Omia）2026-09-16 的做法：
//   xiaoer-omia/src/lib/fileDocumentDraft.ts 的 resolveExternalFileChange / sourceContentFingerprint
// 那边走的也是「agent 写磁盘文件、应用定时重读」这一条路（缘由写在 lib/folderOps.ts 顶部：
// agent 被沙箱关着起不了外部 app，改完文件用户看着还是旧内容，所以只能走文件通道 + 轮询）。
//
// 规则只有三条，缺一条就出问题：
//   指纹一样              → unchanged：什么都不做。少了这条，轮询每 2 秒重挂一次编辑器，
//                          光标会丢、滚动会跳，用户会以为软件在抽风。
//   指纹变了 + 本地干净    → reload：磁盘上的新内容才是对的，读进来。
//   指纹变了 + 本地有改动  → conflict：用户在编辑器里敲的字优先，绝不覆盖。Omia 那边
//                          也只有用户显式点「覆盖」才会用磁盘版本。
export function resolveExternalFileChange({ dirty, baseFingerprint, diskFingerprint, draftRevision }) {
  if (baseFingerprint === diskFingerprint) return { outcome: 'unchanged' };
  return dirty ? { outcome: 'conflict', draftRevision } : { outcome: 'reload' };
}

/** 与 Omia 同算法、同格式（FNV-1a 32 位 over UTF-8 + 字节数）。不是安全哈希，只判「底本换没换」。 */
export function sourceContentFingerprint(content) {
  return sourceBytesFingerprint(new TextEncoder().encode(content));
}

export function sourceBytesFingerprint(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}:${bytes.length}`;
}
