import { createBrowserRouter, redirectDocument, type LoaderFunctionArgs } from "react-router-dom";
import { router } from "./router";

/** 公开页只挂载情报内容，进入个人栏目时先经过整页认证和台账初始化。 */
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
      loader: ({ params, request }: LoaderFunctionArgs) => params.tab === "dingtalk" ? null : redirectDocument(request.url),
    }, {
      path: "*",
      loader: ({ request }: LoaderFunctionArgs) => redirectDocument(request.url),
    }],
  }], { basename: import.meta.env.BASE_URL });
}
