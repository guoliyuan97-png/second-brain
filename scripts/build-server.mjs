/**
 * 服务端打包脚本:用 esbuild JS API 替代命令行 ——
 * 避免 Windows cmd 下长参数引号转义问题(banner 里含 import 语句)。
 * @huggingface/transformers 保持 external:原生模块(onnxruntime-node)不能被打包,
 * 运行时从 resources/app/node_modules 解析(见 package.json build.files)。
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/web/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'build/server.mjs',
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  external: ['@huggingface/transformers'],
  logLevel: 'warning',
});
console.log('build/server.mjs 已生成');
