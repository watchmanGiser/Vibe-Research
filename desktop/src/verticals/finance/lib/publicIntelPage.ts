/** 广州公开情报页独立启动，个人页面仍先读取真实台账。 */
export function isPublicDingTalkPage(pathname: string, basePath: string): boolean {
  if (basePath !== "/vibe-research/") return false;
  return pathname.replace(/\/$/, "") === "/vibe-research/intel/dingtalk";
}

export async function prepareFinancePage(
  pathname: string,
  basePath: string,
  hydrateNotes: () => Promise<void>,
  hydrateWatch: () => Promise<void>,
): Promise<boolean> {
  if (isPublicDingTalkPage(pathname, basePath)) return true;
  await Promise.all([hydrateNotes(), hydrateWatch()]);
  return false;
}
