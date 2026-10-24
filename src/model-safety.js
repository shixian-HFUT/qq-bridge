// Model-facing content safety helpers.
//
// This boundary is deliberately separate from storage and the OneBot protocol:
// state files and console/API diagnostics keep original QQ nicknames, while data
// serialized for the model is either replaced by a stable identity or masked.
//
// The list is intentionally conservative: multi-character sexual terms and
// common homophones are matched, but broad single characters are avoided to
// reduce false positives on ordinary conversation. Extend it as new concrete
// moderation failures are observed.

const UNSAFE_MODEL_TERMS = [
  '性交', '性行为', '性爱', '做爱', '口交', '肛交', '足交', '手交', '乳交', '耳交',
  '约炮', '打炮', '强奸', '强暴', '迷奸', '猥亵', '性侵', '鸡奸', '兽交', '乱伦',
  '卖淫', '嫖娼', '招嫖', '鸡巴', '鸡8', '龟头', '阴道', '阴蒂', '小穴', '嫩穴',
  '母狗', '骚货', '荡妇', '精液', '内射', '颜射', '潮吹', '手淫', '自慰',
  '牛子', '牛至', '鸡鸡', '傻逼', '草泥马'
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UNSAFE_MODEL_TEXT_RE = new RegExp(UNSAFE_MODEL_TERMS.map(escapeRegExp).join('|'), 'giu');
const SAFETY_SEPARATOR = '(?:[\\s\\p{P}\\p{S}])*';
const UNSAFE_MODEL_OBFUSCATED_RE = new RegExp(
  UNSAFE_MODEL_TERMS.map((term) => Array.from(term).map(escapeRegExp).join(SAFETY_SEPARATOR)).join('|'),
  'giu'
);
const SAFETY_SEPARATOR_RE = /[\s\p{P}\p{S}]/gu;

export function normalizeForModelSafety(value) {
  return String(value ?? '').replace(SAFETY_SEPARATOR_RE, '').toLowerCase();
}

export function containsUnsafeModelText(value) {
  const text = String(value ?? '');
  if (!text) return false;
  UNSAFE_MODEL_TEXT_RE.lastIndex = 0;
  UNSAFE_MODEL_OBFUSCATED_RE.lastIndex = 0;
  return UNSAFE_MODEL_TEXT_RE.test(text) || UNSAFE_MODEL_OBFUSCATED_RE.test(text);
}

export function maskModelText(value) {
  const text = String(value ?? '');
  if (!text) return text;
  return text.replace(UNSAFE_MODEL_OBFUSCATED_RE, '***');
}

export function safeModelDisplayName(name, uid) {
  const raw = String(name ?? '').trim();
  const id = String(uid ?? '').trim();
  const fallback = id ? `群友(${id})` : '群友';
  if (!raw) return fallback;
  return containsUnsafeModelText(raw) ? fallback : raw;
}
