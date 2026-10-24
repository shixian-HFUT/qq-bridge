import { createHash } from 'node:crypto';

export const IMAGE_REJECTION_NOTICE = '模型服务未接受本轮输入图片，本轮已结束。原图已保留，后续不会自动向同一模型重复提交这些图片；可以继续文字聊天。';
const OMITTED_IMAGE = '【图片未提供】模型服务曾拒绝处理这张图片，未提供图像内容。不要猜测图片内容或重复请求处理这张图。';
const hash = value => createHash('sha256').update(value).digest('hex');

// Only this specific image inspection failure can change future image context.
// Timeouts, auth errors, and text inspection failures must leave images alone.
export function isInputImageRejection(error) {
  const text = typeof error === 'string' ? error : String(error?.message || error?.errorMessage || '');
  return /data_?inspection_?failed/i.test(text) && /input[\s_-]+image/i.test(text);
}

function imageKey(block) {
  if (block?.type !== 'image') return null;
  if (typeof block.bridgeImageRef === 'string' && /^[a-f0-9]{64}$/.test(block.bridgeImageRef)) return block.bridgeImageRef;
  return typeof block.data === 'string' && block.data.length ? hash(block.data) : null;
}

// Archive content stays intact. The guard only changes the model projection.
// The provider cannot identify the offending image, so all images in that
// rejected request are withheld from this session's subsequent requests.
export class ImageInputGuard {
  constructor(session, config) {
    this.session = session;
    this.scope = hash(JSON.stringify([config.provider, config.baseURL, config.model]));
    const saved = session.imageInputRejections?.[this.scope]?.hashes;
    this.rejected = new Set(Array.isArray(saved) ? saved.filter(x => /^[a-f0-9]{64}$/.test(x)) : []);
    this.submitted = new Set();
  }

  project(messages) {
    this.submitted = new Set();
    return messages.map(message => {
      if (!Array.isArray(message.content)) return message;
      return { ...message, content: message.content.map(block => {
        const key = imageKey(block);
        if (!key) return block;
        if (this.rejected.has(key)) return { type: 'text', text: OMITTED_IMAGE };
        this.submitted.add(key);
        return block;
      }) };
    });
  }

  rememberFailure(error) {
    if (!isInputImageRejection(error) || !this.submitted.size) return 0;
    for (const key of this.submitted) this.rejected.add(key);
    this.session.imageInputRejections ||= {};
    this.session.imageInputRejections[this.scope] = {
      hashes: [...this.rejected], rejectedAt: Date.now(), code: 'input_image_inspection_failed',
    };
    return this.submitted.size;
  }
}
