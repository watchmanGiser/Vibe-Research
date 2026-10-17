/** 用户已确认的简称对应名称仅着色，保留原有文字。 */
const names = /(衡东光|中际旭创|新易盛|联特科技|罗博特科|(?<![A-Za-z0-9_])Coherent(?![A-Za-z0-9_]))/g;
export function DingTalkCompanyText({ text }: { text: string }) {
  return <>{text.split(names).map((part, index) => index % 2
    ? <span key={index} className="text-blue-600 dark:text-blue-400">{part}</span>
    : part)}</>;
}
