/** 整理展示空白和图片占位，原始归档仍保留完整文本。 */
export interface DingTalkImage { reference: string; url: string }

export function compactDingTalkText(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0).join('\n').trim();
}

function safeImageUrl(value: string): boolean {
  if (/^\/dingtalk\/media\/[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export function dingTalkContent(original: string, cachedImages: DingTalkImage[] = []) {
  const cached = new Map(cachedImages.filter(image => safeImageUrl(image.url)).map(image => [image.reference, image.url]));
  const images: DingTalkImage[] = [];
  const seen = new Set<string>();
  const text = original
    .replace(/(?:图片内容[：:]\s*)?<imageContent>([\s\S]*?)<\/imageContent>/g, (_match, content: string) => {
      const description = compactDingTalkText(content);
      return !description || /^(?:image|photo|picture|img)(?:[ _.-]?\d+)?\.(?:jpe?g|png|gif|webp|heic)$/i.test(description) ? '\n' : `\n图片内容：${description}\n`;
    })
    .replace(/\[图片消息\]\(mediaId=([^\r\n)]+)\)/g, (_match, value: string) => {
      const reference = value.trim();
      if (!seen.has(reference)) {
        seen.add(reference);
        const url = cached.get(reference) || (safeImageUrl(reference) ? reference : '');
        images.push({ reference, url });
      }
      return '\n';
    });
  return { text: compactDingTalkText(text), images };
}
