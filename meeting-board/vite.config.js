import { defineConfig } from 'vite';

export default defineConfig({
  base: '/meeting-board/',
  // 白板这一层没有 tsconfig，esbuild 会退回 classic JSX（emit React.createElement），
  // 而从 xiaoer-omia 移植过来的 .tsx 都是「只 import 具名 hooks」的写法 —— 运行时直接
  // Can't find variable: React，整个白板空白。这里显式选 automatic JSX，和那些文件的写法一致。
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: '../dist/meeting-board',
    emptyOutDir: true,
  },
});