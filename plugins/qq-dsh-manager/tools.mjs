// Loaded only by the qq-dsh-manager agent preset, never by the QQ chat preset.
export const name = 'qq-dsh-manager-tools';
export const inject = ['tools'];
export function apply(ctx) {
  // Preset tools are ancestors of the actual agent. An empty allow-list on
  // this preset would also hide bot_manage from its child agent in DSH 0.2.
  // Deny inherited global tools by name; the guard also rejects future tools.
  ctx.tools.presentAs('native');
  const hidden = new Set();
  const hideGlobals = () => {
    for (const tool of ctx.tools.schemas()) {
      if (tool.name === 'bot_manage' || tool.name === 'run_code' || hidden.has(tool.name)) continue;
      hidden.add(tool.name);
      ctx.tools.restrict({ deny: [tool.name] });
    }
  };
  hideGlobals();
  ctx.on('tools/change', hideGlobals);
  ctx.tools.guard(exec => exec?.name === 'bot_manage' ? undefined : '只允许本次任务的 bot_manage 工具');
  ctx.tools.register({
    name: 'bot_manage',
    description: '机器人管理工具。action=read_settings 可提供 key(group:群号/private:QQ号)。patch_settings 参数为 scope(send/wake/roleMode)、key(仅wake)、patch。send 支持 maxSendPerMinute(1~30)、maxSendPerHour(1~600)；wake 支持 observationMs/batchWindowMs(1000~3600000)、群 observationPolicy(fixed/sliding)、triggers(probability 0~1、atMention/nameMention布尔)；roleMode 的 patch={mode:active或silent}。list_files/read_file 读取 src/docs/roles 相对路径；read_log 只支持 state/qq-activity.log。argsJson 为上述参数的 JSON 对象字符串。修改前先查当前设置；按明确请求改最少字段。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      jobToken: { type: 'string', description: '任务提供的临时凭据' },
      action: { type: 'string', enum: ['read_settings', 'patch_settings', 'list_files', 'read_file', 'read_log'] },
      argsJson: { type: 'string', description: '参数 JSON 对象，如 {"key":"group:123"}' },
    }, required: ['jobToken', 'action', 'argsJson'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const parsed = JSON.parse(args.argsJson);
      const response = await fetch('http://127.0.0.1:15101/manage', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([exec.signal, AbortSignal.timeout(25000)]),
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + args.jobToken },
        body: JSON.stringify({ action: args.action, args: parsed }),
      });
      const text = await response.text();
      if (text.length > 40000) throw Error('管理结果过大');
      return text;
    },
  });
}
