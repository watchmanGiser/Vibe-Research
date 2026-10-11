/** 受鉴权保护的只读扩展端点；具体业务由注册入口注入。 */
export type ReadOnlyEndpoint = (query: URLSearchParams) => unknown | Promise<unknown>;
const endpoints = new Map<string, ReadOnlyEndpoint>();

export class ApiExtensionError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function registerReadOnlyEndpoint(pathname: string, handler: ReadOnlyEndpoint): void {
  if (!pathname.startsWith("/") || endpoints.has(pathname)) throw new Error("扩展端点路径无效或重复");
  endpoints.set(pathname, handler);
}

export function readOnlyEndpoint(pathname: string): ReadOnlyEndpoint | undefined {
  return endpoints.get(pathname);
}
