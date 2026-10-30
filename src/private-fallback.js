// Also supports a trusted research-stop notice when no reply effect was attempted.
// Both notices share the original private-only delivery and duplicate guards.
// 私聊「媒体发送确定失败 + 没有可见回复」的确定性兜底（纯函数，无 I/O、无网络）。
//
// 事故形态：私聊普通唤醒里，图片发送工具已经给出**确定未发送**的结果（unknown=false），
// 同一批还调用了 mark_read，模型随后空输出。reserved2 下模型文字不会自动转发，
// 于是用户只被已读、收不到任何东西。本模块只决定「该不该补一句固定提示」，
// 真正的发送仍由桥接走既有会话绑定 / 白名单 / 静默 / 限流路径。
//
// 安全边界：
// - 只在 Pi 后端 + 显式 simpleTools + 可信 chat-wake + 私聊 + 有原用户消息时生效；
// - 媒体结果未知（unknown）、可能已发送（duplicate）、已成功、部分成功一律不补发；
// - 不转发模型文字、工具报错、URL、令牌或任何用户隐私，只发固定一句；
// - 本模块不发送、不标记已读、不推进水位；同回合最多一次，失败也不重试（由调用方保证）。
import { stripSnowlumaPrefix } from './simple-tools.js';

/** 固定的失败说明：不含任何内部细节（模型文字/工具报错/URL/密钥）。 */
export const PRIVATE_MEDIA_FALLBACK_TEXT = '刚才想发的东西没发出去，抱歉。可以稍后再试一次，或者先用文字聊。';

/** 媒体发送类工具（短名，已去掉 mcp__snowluma__ 前缀）。 */
export const PRIVATE_FALLBACK_MEDIA_TOOLS = Object.freeze([
  'qq_send_image',
  'qq_send_generated_image',
  'qq_send_voice',
  'qq_send_sticker',
  'qq_speak'
]);

/** 会给用户产生可见内容的发送类工具（mark_read / wake / 只读工具不在其中）。 */
export const PRIVATE_FALLBACK_VISIBLE_TOOLS = Object.freeze([
  'qq_send_message',
  'qq_send_burst',
  'qq_send_group_message',
  'qq_send_private_message',
  'qq_reply',
  'qq_send_image',
  'qq_send_generated_image',
  'qq_send_voice',
  'qq_send_sticker',
  'qq_speak'
]);

const MEDIA = new Set(PRIVATE_FALLBACK_MEDIA_TOOLS);
const VISIBLE = new Set(PRIVATE_FALLBACK_VISIBLE_TOOLS);

/** 单回合的事实累计器：不做判断，只记录工具结果属于哪一类。 */
export function createPrivateMediaTurnFacts() {
  return {
    mediaAttempted: false,
    mediaDefiniteFailure: false, // 至少一次“确定未发送”的媒体失败
    mediaUnclear: false,         // 媒体结果未知 / 重复 / 部分成功
    visibleSucceeded: false,     // 有可见发送成功
    sendUnclear: false,          // 非媒体发送结果不明确（可能部分发出）
    notified: false              // 本回合已经尝试过兜底（成功失败都算）
  };
}

export function canonicalFallbackToolName(name) {
  return stripSnowlumaPrefix(String(name ?? ''));
}

/**
 * 记录一次工具结果。data 是工具返回的 JSON 载荷（解析失败时为 null）。
 * 规则只有“确定未发送”才算媒体失败：ok=false 且 unknown===false 且 duplicate!==true，
 * 且没有任何已发条数。拿不到显式 unknown=false 的失败（网络错误、旧工具形状）
 * 一律按“结果不明”处理，宁可不发提示也不误报。
 */
export function notePrivateFallbackToolResult(facts, name, { data = null } = {}) {
  if (!facts) return facts;
  const tool = canonicalFallbackToolName(name);
  const media = MEDIA.has(tool);
  const visible = VISIBLE.has(tool);
  if (!media && !visible) return facts;
  if (media) facts.mediaAttempted = true;
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const sentCount = Number(payload?.sent);
  const failedCount = Number(payload?.failed);
  const sentSome = Number.isFinite(sentCount) && sentCount > 0;
  const failedSome = Number.isFinite(failedCount) && failedCount > 0;
  const unclear = () => {
    facts.sendUnclear = true;
    if (media) facts.mediaUnclear = true;
    return facts;
  };
  if (payload?.ok === true) {
    // 已发送（含部分成功）：用户已经看到内容，不能再补一条失败说明。
    if (Number.isFinite(sentCount) && sentCount === 0 && !failedSome) return unclear();
    facts.visibleSucceeded = true;
    return facts;
  }
  if (sentSome) {
    // 失败响应里仍带“已发条数”：说明是部分成功，已发出的部分不能让用户再收到
    // 一条与之矛盾的失败提示。
    facts.visibleSucceeded = true;
    if (media) facts.mediaUnclear = true;
    return facts;
  }
  if (failedSome) return unclear();
  // 只有“确定未发送”（unknown=false 且不是重复）才算媒体失败；拿不到显式
  // 传输语义的失败（网络错误、旧工具形状、非 JSON）一律按结果不明处理。
  const definiteNotSent = payload?.ok === false && payload.unknown === false && payload.duplicate !== true;
  if (definiteNotSent) {
    if (media) facts.mediaDefiniteFailure = true;
    else facts.sendUnclear = true; // 文字发送没有“确定未发”的语义，按不明处理
    return facts;
  }
  return unclear();
}

/**
 * 是否要在本回合结束后补发固定提示。
 * 所有输入都必须来自可信来源（Pi 运行时的当轮上下文、工具结果、会话状态）。
 *
 * pendingMediaJobs 只表示**本轮创建/查询过、且此刻仍未完成**的媒体任务；
 * 历史遗留的 pendingImageJobs 不能永久抑制新的失败提示（任务可能早已失联）。
 */
export function shouldNotifyPrivateMediaFailure(facts, {
  notifierAvailable = false,
  backend = '',
  simpleTools = false,
  mode = null,
  kind = null,
  key = '',
  requestMessageId = null,
  learningTurn = false,
  pendingMediaJobs = false,
  researchStopped = false,
  turnFailed = false,
  cancelled = false,
  disposed = false
} = {}) {
  const no = reason => ({ notify: false, reason });
  if (!notifierAvailable) return no('no-notifier');
  if (backend !== 'pi') return no('backend');
  if (simpleTools !== true) return no('switch-off');
  if (mode !== 'reserved2') return no('mode');
  if (kind !== 'chat-wake') return no('kind');
  if (learningTurn) return no('learning');
  if (!/^private:[1-9]\d*$/.test(String(key ?? ''))) return no('not-private');
  if (requestMessageId === null || requestMessageId === undefined || String(requestMessageId) === '') {
    return no('no-user-message');
  }
  if (turnFailed) return no('turn-failed');
  if (cancelled) return no('cancelled');
  if (disposed) return no('disposed');
  if (pendingMediaJobs) return no('pending-media-job');
  if (!facts || facts.notified) return no('already-notified');
  if (facts.visibleSucceeded) return no('visible-reply');
  if (facts.mediaUnclear || facts.sendUnclear) return no('unclear-outcome');
  // The caller supplies this flag only after its per-turn research guard fired,
  // with zero visible/generation attempts. Never infer it from model prose.
  if (researchStopped && !facts.mediaAttempted) return { notify: true, reason: 'research-stop' };
  if (!facts.mediaDefiniteFailure) return no('no-definite-media-failure');
  return { notify: true, reason: 'definite-media-failure' };
}

/**
 * 桥接侧的最终放行判定（发送前的运行时校验）。任何一项不满足都不发，也不重试。
 * 这些校验与既有发送端点同源：模式 / 开关 / 暂停 / 私聊 / 会话绑定 / 白名单 /
 * 静默 / 限流 / 同一条消息只提示一次。
 * simpleTools / sendMessageEnabled 必须在发送前按**当前**配置复核：模型侧入口与
 * 桥接自己的发送记录都不能在开关关闭后继续产生可见消息。
 * tokenValid 表示本轮可信会话令牌此刻仍属于该会话；会话重置/令牌轮换后必须失效。
 */
export function evaluatePrivateFallbackDelivery({
  mode = null,
  enabled = true,
  simpleTools = false,
  sendMessageEnabled = false,
  paused = false,
  key = '',
  sessionBound = false,
  allowed = false,
  silent = false,
  rateLimited = false,
  tokenValid = false,
  duplicate = false
} = {}) {
  const no = reason => ({ deliver: false, reason });
  if (mode !== 'reserved2') return no('mode');
  if (enabled === false) return no('disabled');
  if (simpleTools !== true) return no('simple-tools-off');
  if (sendMessageEnabled !== true) return no('send-message-off');
  if (paused) return no('paused');
  if (!/^private:[1-9]\d*$/.test(String(key ?? ''))) return no('not-private');
  if (!allowed) return no('not-allowed');
  if (!sessionBound) return no('stale-session');
  if (silent) return no('silent');
  if (rateLimited) return no('rate-limited');
  if (tokenValid !== true) return no('token-invalid');
  if (duplicate) return no('duplicate');
  return { deliver: true, reason: 'ok' };
}
