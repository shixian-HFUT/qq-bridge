// A cue asks the current chat model to consider a sourced write; it never
// turns a regex match into a durable fact or grants any extra tool authority.
export function memoryCaptureHint(messages) {
  const cue = /记住|帮我记|记一下|以后|今后|下次|从今|我(?:不|更|最)?喜欢|我偏好|我习惯|我讨厌|我受不了|约定|说好|答应|说定|别再|不要再|别叫我|叫我|称呼|更正|纠正|记错了|我说过|提醒我|整理.{0,8}记忆/u;
  const candidates = (Array.isArray(messages) ? messages : []).filter(message => {
    const text = String(message?.plain ?? message?.text ?? '');
    return !message?.isSelf && !message?.hasForward && !message?.forwardIds?.length
      && /^\d{5,12}$/.test(String(message?.userId || ''))
      && message.messageId && cue.test(text);
  }).slice(-3);
  if (!candidates.length) return '';
  const refs = candidates.map(message => `QQ=${message.userId},sourceMessageId=${String(message.messageId).slice(0, 64)}`).join('；');
  return `\n【本轮记忆线索】${refs}。先核对快照中本人的原话，值得长期保留的明确偏好/事实可随qq_send_message.memoryOps保存，或不发言时用qq_memory_append。重点是：稳定偏好与习惯、明确约定或承诺、边界与雷区、对人对事的明确态度、以及本人对你的纠正；不止"喜欢什么"。event/lesson 可以由你自己判断值得就记（有意义的互动、改变印象的事、相处的心得），说得清为什么值得留即可；没有关键词提示时也一样。纠正同一偏好应更新旧条目，必要时先查询id/revision。转述、玩笑和推断不作为本人事实；关键词只是线索，不是保存命令。工具成功才表示已落盘，不在发送终结后补写或为了记忆失败重发QQ。`;
}
