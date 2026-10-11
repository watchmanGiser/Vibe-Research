/**
 * 生成同源 API 地址。
 * 开发环境 BASE_URL 为 /，生产环境可挂载在 /vibe-research/ 等子路径。
 */
const runtimeBaseUrl = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";

export function apiUrl(path: string, baseUrl = runtimeBaseUrl): string {
  const base = baseUrl === "/" ? "" : `/${baseUrl.replace(/^\/+|\/+$/g, "")}`;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}/api${suffix}`;
}
