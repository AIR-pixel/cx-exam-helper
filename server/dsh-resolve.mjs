/**
 * dsh-resolve.mjs —— ESM loader hook
 *
 * 插件 @dmh2002/dsh-connect-qoder 是纯 ESM，裸导入了 DSH 自己的包
 * （@deepseek-ai/dsh-atomic-write 等）。这些包只装在 DSH 安装目录下，
 * 从工作区的普通 node 进程解析不到，NODE_PATH 对 ESM 无效。
 *
 * 这个 hook 在解析失败时把 @deepseek-ai/* 重定向到 DSH 的 node_modules。
 *
 * 用法：node --import ./dsh-resolve-register.mjs your-script.mjs
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DSH_NODE_MODULES =
  process.env.DSH_NODE_MODULES ||
  'C:\\Users\\air\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app\\dsh\\node_modules';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (!specifier.startsWith('@deepseek-ai/') && !specifier.startsWith('openai')) throw e;

    // 该包在 DSH 的 node_modules 下存在 → 用 DSH 的目录当父级重新解析
    const pkgName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];
    const pkgDir = join(DSH_NODE_MODULES, pkgName.replace('/', '\\'));
    if (!existsSync(pkgDir)) throw e;

    const fakeParent = pathToFileURL(join(DSH_NODE_MODULES, '_resolver_.js')).href;
    return nextResolve(specifier, { ...context, parentURL: fakeParent });
  }
}