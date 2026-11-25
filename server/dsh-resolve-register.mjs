/**
 * dsh-resolve-register.mjs —— 注册 dsh-resolve.mjs 这个 ESM loader hook。
 *
 * 第二个参数必须是「本文件」的 URL，不能是 pathToFileURL('./')。
 * 后者按进程 cwd 解析：从仓库根跑 `node --import ./server/dsh-resolve-register.mjs`
 * 时会去找 <repo>/dsh-resolve.mjs（不存在），报 ERR_MODULE_NOT_FOUND，
 * 而这个错误发生在 import 阶段，看起来像「插件依赖缺失」，极难定位。
 * 用 import.meta.url 让它跟启动目录无关。
 */
import { register } from 'node:module';

register('./dsh-resolve.mjs', import.meta.url);
