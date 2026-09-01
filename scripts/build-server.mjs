/**
 * 服务端打包脚本:用 esbuild JS API 替代命令行 ——
 * 避免 Windows cmd 下长参数引号转义问题(banner 里含 import 语句)。
 * @huggingface/transformers 保持 external:原生模块(onnxruntime-node)不能被打包,
 * 运行时从 resources/app/node_modules 解析(见 package.json build.files)。
 * 两个入口:build/server.mjs(Web/Electron 主服务)+ build/mcp.mjs(MCP stdio 服务)。
 */
import { build } from 'esbuild';

const banner = {
  js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
};

for (const [entry, outfile] of [
  ['src/web/server.ts', 'build/server.mjs'],
  ['src/mcp/server.ts', 'build/mcp.mjs'],
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    banner,
    external: ['@huggingface/transformers'],
    logLevel: 'warning',
  });
  console.log(`${outfile} 已生成`);
}
