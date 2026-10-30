// Pure input normalization; never chooses a picture or performs a send.
export const MAX_BATCH_IMAGES = 8;

function boundedList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_IMAGES) throw Error(`${label}需为1至${MAX_BATCH_IMAGES}项的数组`);
  return value;
}

export function normalizeImageBatch(body) {
  if (body.urls !== undefined) {
    if (['url', 'sourceMessageId', 'imageIndex', 'imageIndexes'].some(k => body[k] !== undefined)) throw Error('urls不能与单图或聊天图片参数混用');
    const urls = boundedList(body.urls, 'urls').map(url => {
      if (typeof url !== 'string' || !url.trim()) throw Error('urls每项必须是非空图片直链');
      return url.trim();
    });
    return { batch: true, items: urls.map(url => ({ url })) };
  }
  if (body.imageIndexes !== undefined) {
    if (body.url !== undefined || body.imageIndex !== undefined || !String(body.sourceMessageId || '').trim()) throw Error('imageIndexes需配合sourceMessageId，不能与url或imageIndex混用');
    const indexes = boundedList(body.imageIndexes, 'imageIndexes');
    if (indexes.some(n => !Number.isSafeInteger(n) || n < 1 || n > 5) || new Set(indexes).size !== indexes.length) throw Error('imageIndexes需为不重复的1至5整数');
    return { batch: true, items: indexes.map(imageIndex => ({ sourceMessageId: body.sourceMessageId, imageIndex })) };
  }
  return { batch: false, items: [body] };
}

export function normalizeStickerRefs(value) {
  const list = Array.isArray(value) ? boundedList(value, 'stickerId') : [value];
  const refs = list.map(ref => {
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 512) throw Error('stickerId需为可用表情ID，或1至8个ID的数组');
    return ref.trim();
  });
  if (new Set(refs).size !== refs.length) throw Error('同一组不能重复同一个表情ID');
  return refs;
}
