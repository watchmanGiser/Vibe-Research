import { createBrowserRouter, redirectDocument, type LoaderFunctionArgs } from "react-router-dom";
import { router } from "./router";
import { prepareFinancePage } from "./lib/publicIntelPage";
import { hydrateNotes } from "./lib/notes";
import { hydrateWatch } from "./lib/watchlist";

/** 情报标签直接切换并加载真实台账；其他工作台栏目整页进入。 */
export function createPublicDingTalkRouter() {
  const root = router.routes[0];
  const intel = root?.children?.find(route => route.path === "/intel/:tab");
  if (!root || !intel) throw new Error("公开情报路由未配置");
  return createBrowserRouter([{
    ...root,
    index: false,
    children: [{
      ...intel,
      index: false,
      loader: async ({ request }: LoaderFunctionArgs) => {
        await prepareFinancePage(new URL(request.url).pathname, import.meta.env.BASE_URL, hydrateNotes, hydrateWatch);
        return null;
      },
    }, {
      path: "*",
      loader: ({ request }: LoaderFunctionArgs) => redirectDocument(request.url),
    }],
  }], { basename: import.meta.env.BASE_URL });
}
