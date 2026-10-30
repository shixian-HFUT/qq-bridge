// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
import { maskModelText, safeModelDisplayName } from './model-safety.js';

const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'directedToYou', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds', 'voiceRequestMessageId'
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function uidFrom(record) {
  return record?.userId ?? record?.user_id ?? record?.uid ?? null;
}

function sanitizeModelIdentity(record) {
  if (!isRecord(record)) return record;
  // Older stored bot replies incorrectly carried the owner's marker. Correct
  // their model-facing identity without rewriting local conversation records.
  if (record.isSelf === true) {
    record.isOwner = false;
    delete record.ownerLabel;
  }
  if (typeof record.sender === 'string') {
    record.sender = safeModelDisplayName(record.sender, uidFrom(record));
  }
  if (typeof record.nickname === 'string') {
    record.nickname = safeModelDisplayName(record.nickname, record.user_id ?? record.userId ?? record.uid);
  }
  if (typeof record.card === 'string') {
    record.card = safeModelDisplayName(record.card, record.user_id ?? record.userId ?? record.uid);
  }
  return record;
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

export function compactModelMessage(message) {
  if (!isRecord(message)) return message;
  const result = { ...message };
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  sanitizeModelIdentity(result);
  for (const [key, value] of Object.entries(result)) {
    result[key] = compactModelData(value, key);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

export function compactModelData(data, parentKey = '') {
  if (Array.isArray(data)) {
    return data.map((item) => (
      parentKey === 'messages' || parentKey === 'newMessages'
        ? compactModelMessage(item)
        : compactModelData(item, parentKey)
    ));
  }
  if (!isRecord(data)) return typeof data === 'string' ? maskModelText(data) : data;
  const result = sanitizeModelIdentity({ ...data });
  for (const [key, value] of Object.entries(result)) {
    if ((key === 'messages' || key === 'newMessages') && Array.isArray(value)) {
      result[key] = value.map(compactModelMessage);
    } else {
      result[key] = compactModelData(value, key);
    }
  }
  return result;
}

export function serializeModelData(data) {
  return JSON.stringify(compactModelData(data));
}
