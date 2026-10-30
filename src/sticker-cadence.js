// Conversation-local feedback for a soft preference. Never chooses or sends a sticker.
const bounded = value => Math.min(100, Math.max(0, Math.floor(Number(value) || 0)));
export function normalizeStickerCadence(value) {
  return { repliesWithoutSticker: bounded(value?.repliesWithoutSticker),
    lastStickerAt: Math.max(0, Number(value?.lastStickerAt) || 0) };
}
export function stickerCadenceState(st) {
  st.stickerCadence = normalizeStickerCadence(st.stickerCadence);
  return st.stickerCadence;
}
export function noteReplyWithoutSticker(st) {
  const state = stickerCadenceState(st);
  state.repliesWithoutSticker = bounded(state.repliesWithoutSticker + 1);
}
export function noteStickerSent(st, now = Date.now()) {
  Object.assign(stickerCadenceState(st), { repliesWithoutSticker: 0, lastStickerAt: now });
}
export function buildStickerCadenceHint(st) {
  const count = stickerCadenceState(st).repliesWithoutSticker;
  if (count < 3) return '';
  return `【表情节奏】本会话已连续${count}次实际回复没有收藏表情包。若本轮是轻松闲聊、接梗或表达情绪，下一次回复优先配1张合适的收藏表情；可同一次send传stickerId，不必多调用一次。严肃话题、资料问题或没有合适表情时照常回复，不为凑次数硬发；emoji和颜文字不抵这个计数。已发送或结果不明的内容不要补发。\n`;
}
