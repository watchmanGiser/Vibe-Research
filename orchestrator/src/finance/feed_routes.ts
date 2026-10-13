/** 广州信息流只读路由，与研究工具及模型权限独立。 */
import { ApiExtensionError, registerReadOnlyEndpoint } from "../api_extensions.ts";
import { fetchSemi, SemiUpstreamError } from "./semi.ts";
import { fetchDingTalkGroup, DingTalkSnapshotError } from "./dingtalk_semi.ts";
import { fetchDingTalkMessages } from "./dingtalk_raw.ts";

const handled = (fn: (query: URLSearchParams) => unknown | Promise<unknown>) => async (query: URLSearchParams) => {
  try { return await fn(query); }
  catch (error) {
    if (error instanceof SemiUpstreamError || error instanceof DingTalkSnapshotError) {
      throw new ApiExtensionError(error.message, error.status);
    }
    throw error;
  }
};
registerReadOnlyEndpoint("/semi/health", handled(() => fetchSemi("/api/health")));
registerReadOnlyEndpoint("/semi/status", handled(() => fetchSemi("/api/status")));
registerReadOnlyEndpoint("/semi/tweets", handled((query) => fetchSemi("/api/tweets", query)));
registerReadOnlyEndpoint("/semi/dingtalk", handled((query) => query.get("view") === "messages"
  ? fetchDingTalkMessages(query) : fetchDingTalkGroup(Number(query.get("limit") ?? 200))));
