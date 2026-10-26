// In-process Pi runtime. The small response/event facade lets the existing QQ
// scheduler and console keep working without a DSH server or browser protocol.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repairToolPairs, projectPiContext, terminalToolResult, piContent } from './pi-context.js';
import { PiMediaStore } from './pi-media-store.js';
import { PiMaintenance } from './pi-maintenance.js';
import { ImageInputGuard, IMAGE_REJECTION_NOTICE } from './pi-image-rejection.js';
import {
  buildToolExposure, sanitizeTurnContext, shouldOfferFormatCorrection, redactToolArgumentsForRecord,
  isActionToolName, simpleToolsEnabled, advanceTurnCursor, isCursorSourceTarget,
  SIMPLE_TOOLS_PROMPT_NOTE, FORMAT_CORRECTION_TEXT, SIMPLE_CORRECTION_MAX_STREAK
} from './simple-tools.js';

const ok = value => ({ result: { ok: true, value } });
const fail = (code, message) => ({ result: { ok: false, error: { code, message } } });
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Pi archive is unreadable; refusing to overwrite it: ' + file); }
}
function resultData(result) {
  for (const c of result?.content || []) if (c.type === 'text') { try { return JSON.parse(c.text); } catch {} }
  return null;
}
function credential(config) {
  const ref = config.apiKeyEnv || 'APIMART_API_KEY';
  // Explicit project credentials must not be shadowed by another project's
  // inherited environment key (for example the desktop app's provider key).
  if (config.credentialSource !== 'file' && process.env[ref]) return process.env[ref];
  const file = config.credentialFile || path.join(os.homedir(), '.dsh', '.env');
  const source = fs.readFileSync(file, 'utf8');
  const hit = source.split(/\r?\n/).find(l => l.startsWith(ref + '='));
  const value = hit?.slice(ref.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!value) throw new Error(`Pi credential ${ref} is not configured`);
  return value;
}

export class PiApiClient {
  constructor({ root, config, rolePrompt = () => '', streamFn, tools, Agent, sdk, learningBudget } = {}) {
    this.learningBudget = learningBudget;
    // 工具简写适配：只有显式 config.simpleTools=true 才启用，默认完全沿用旧行为。
    this.simpleTools = simpleToolsEnabled(config);
    this.root = root;
    this.config = { credentialFile: path.join(root, '.env'), ...config };
    if (this.config.credentialFile && !path.isAbsolute(this.config.credentialFile)) this.config.credentialFile = path.resolve(root, this.config.credentialFile);
    this.rolePrompt = rolePrompt; this.backend = 'pi';
    this.dir = path.join(root, 'state', 'pi');
    this.mediaStore = new PiMediaStore(path.join(this.dir, 'media'));
    this.index = readJson(path.join(this.dir, 'index.json'), { workspaces: {}, sessions: {} });
    if (!this.index?.workspaces || !this.index?.sessions || Array.isArray(this.index.sessions)) throw new Error('Pi session index is invalid; refusing to overwrite it');
    this.live = new Map(); this.followed = new Set(); this.inbox = []; this.waiter = null;
    this.transports = []; this.toolsOverride = tools; this.streamOverride = streamFn;
    this.AgentOverride = Agent; this.sdkOverride = sdk; this.disposed = false;
    this.maintenance = new PiMaintenance({ directory: this.dir, config: config.maintenance,
      index: () => this.index, live: this.live, saveSession: session => this.saveSession(session) });
    this.maintenance.start();
    this.workspace = {
      create: async ({ path: dir }) => {
        const prior = Object.values(this.index.workspaces).find(w => w.path === dir);
        if (prior) return ok({ created: false, workspace: prior });
        const w = { workspaceId: 'pi-ws-' + randomUUID(), path: dir };
        this.index.workspaces[w.workspaceId] = w; this.saveIndex();
        return ok({ created: true, workspace: w });
      },
      rename: async ({ workspaceId, title }) => {
        const w = this.index.workspaces[workspaceId]; if (!w) return fail('workspace/not-found', 'Pi workspace not found');
        w.title = title; this.saveIndex(); return ok({});
      },
      archiveSession: async ({ sessionId }) => {
        if (this.index.sessions[sessionId]) this.index.sessions[sessionId].archived = true;
        await this.stopSessionWork(sessionId);
        this.saveIndex(); return ok({});
      },
    };
    this.sessions = {
      create: args => this.createSession(args),
      prompt: args => this.prompt(args),
      selectModel: args => this.selectModel(args),
      list: async () => ok({ sessions: Object.values(this.index.sessions).filter(s => !s.archived) }),
    };
    this.agentPresets = { list: async () => ok({ presets: ['qq-chat', 'qq-chat-v2'].map(id => ({ id, name: id, isDefault: id === 'qq-chat-v2' })) }) };
    this.settings = {
      describe: async () => ok({ namespaces: [
        { ns: 'qq-mode', value: readJson(path.join(root, 'state', 'mode.json'), { mode: 'reserved2' }) },
        { ns: 'agent-presets', value: { default: 'qq-chat-v2' } },
      ] }),
      update: async ({ ns, patch }) => {
        if (ns !== 'qq-mode') return fail('settings/unsupported', 'Pi uses the local bot configuration');
        if (patch.mode === 'closed-agent') return fail('settings/unsupported', 'Pi聊天后端不提供本地执行工具；closed-agent请使用DSH后端');
        const f = path.join(root, 'state', 'mode.json'); writeJson(f, { ...readJson(f, {}), ...patch }); return ok({});
      },
    };
    this.events = {
      follow: id => {
        if (!this.index.sessions[id] || this.followed.has(id)) return;
        this.followed.add(id); const s = this.loadSession(id);
        this.enqueue({ type: 'session/snapshot', sessionId: id, snapshot: { records: s.records, projections: { values: { modelSelection: { lastUsed: s.selection } } } } });
      },
      forget: id => this.followed.delete(id),
      mux: (_args, signal) => this.eventStream(signal),
    };
  }

  saveIndex() { writeJson(path.join(this.dir, 'index.json'), this.index); }
  saveSession(s) {
    this.mediaStore.externalizeSession(s);
    const { agent, runPromise, queue, ...durable } = s;
    writeJson(path.join(this.dir, 'sessions', s.sessionId + '.json'), durable);
  }
  loadSession(id) {
    if (!/^pi-session-[a-f0-9-]+$/.test(id) || !this.index.sessions[id]) throw Error('Pi session not found');
    if (this.live.has(id)) return this.live.get(id);
    const saved = readJson(path.join(this.dir, 'sessions', id + '.json'), null);
    if (!saved) throw Error('Pi session archive missing');
    // Migrate legacy inline images before cloning the history. Preserve every
    // message/event; writing blobs first keeps crash recovery lossless.
    const migrated = this.mediaStore.externalizeSession(saved);
    const wasRunning = saved.running;
    const s = { ...saved, messages: repairToolPairs(saved.messages || []), running: false, queue: [] };
    // Recover a previously rejected image context without another paid request.
    const lastEnd = s.records?.findLast(event => event.type === 'turn/end');
    const imageGuard = new ImageInputGuard(s, this.config);
    imageGuard.project(projectPiContext(s.messages, this.config.contextBudgetTokens || 24000));
    const recoveredImages = lastEnd?.data?.reason?.kind === 'error'
      ? imageGuard.rememberFailure(lastEnd.data.reason.error?.message) : 0;
    this.live.set(id, s);
    if (wasRunning) this.record(s, 'session/end-seed', { reason: 'process-restarted; tool outcomes repaired without replay' });
    else if (migrated || recoveredImages) this.saveSession(s);
    return s;
  }
  enqueue(payload) {
    if (this.disposed) return;
    this.inbox.push({ payload }); this.waiter?.(); this.waiter = null;
  }
  record(s, type, data) {
    const event = { type, seq: ++s.seq, time: Date.now(), data };
    s.records.push(event); if (s.records.length > 500) s.records.splice(0, s.records.length - 500);
    this.saveSession(s);
    if (this.followed.has(s.sessionId)) this.enqueue({ type: 'session/event', sessionId: s.sessionId, event });
  }
  async *eventStream(signal) {
    const wake = () => { this.waiter?.(); this.waiter = null; };
    signal?.addEventListener('abort', wake);
    try {
      while (!this.disposed && !signal?.aborted) {
        while (this.inbox.length) yield this.inbox.shift();
        if (!this.disposed && !signal?.aborted) await new Promise(resolve => { this.waiter = resolve; });
      }
    } finally { signal?.removeEventListener('abort', wake); }
  }

  async initialize() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const sdk = await import(pathToFileURL(path.join(this.root, 'runtime', 'pi', 'sdk.js')).href);
      const core = this.AgentOverride ? { Agent: this.AgentOverride } : sdk;
      const ai = this.sdkOverride || sdk;
      const wire = this.streamOverride ? null : sdk;
      this.Agent = core.Agent; this.models = ai.createModels();
      const cfg = this.config;
      this.model = { id: cfg.model, name: cfg.model, api: 'openai-completions', provider: cfg.provider || 'apimart',
        baseUrl: cfg.baseURL, reasoning: true, input: ['text', 'image'], contextWindow: 262144, maxTokens: cfg.maxTokens || 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { thinkingFormat: 'qwen', supportsReasoningEffort: true, supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: 'max_tokens', ...cfg.compat } };
      if (!this.streamOverride) {
        const api = wire.openAICompletionsApi();
        this.models.setProvider({ id: this.model.provider, name: this.model.provider, baseUrl: cfg.baseURL,
          auth: { apiKey: { name: 'APIMart API key', resolve: async ({ credential: supplied }) => ({
            auth: { apiKey: supplied?.key || credential(cfg) }, source: 'local-credential',
          }) } },
          getModels: () => [this.model], stream: api.stream, streamSimple: api.streamSimple });
      }
      this.toolDefinitions = this.toolsOverride || await this.loadMcpTools();
    })().catch(error => { this.initializing = null; throw error; });
    return this.initializing;
  }

  async loadMcpTools() {
    const definitions = [];
    const sources = [['snowluma', 'mcp-snowluma-safe.js'], ['snowluma-host', 'mcp-host-server.js'], ['web-search-safe', 'mcp-web-search-safe.js']];
    try {
      for (const [namespace, file] of sources) {
        let client, connecting;
        const connect = async () => {
          if (client) return client;
          if (connecting) return connecting;
          connecting = (async () => {
            const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(this.root, 'src', file)], cwd: this.root, stderr: 'pipe' });
            this.transports.push(transport); transport.stderr?.on('data', () => {});
            const next = new Client({ name: 'qq-pi-runtime', version: '1.0.0' }, { capabilities: {} });
            next.onclose = () => { if (client === next) client = null; };
            await next.connect(transport); client = next; return next;
          })().finally(() => { connecting = null; });
          return connecting;
        };
        const discovery = await connect();
        let cursor;
        do {
          const page = await discovery.listTools(cursor ? { cursor } : {}); cursor = page.nextCursor;
          for (const tool of page.tools) {
            const name = `mcp__${namespace}__${tool.name}`;
            definitions.push({ name, label: tool.name, description: tool.description || tool.name, parameters: tool.inputSchema,
              execute: async (_callId, args, signal) => {
                signal?.throwIfAborted();
                const ready = await connect();
                signal?.throwIfAborted();
                // Reconnect before a new call only. Never retry an uncertain send.
                const result = await ready.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: 725000, maxTotalTimeout: 725000 });
                return { content: result.content, details: { bridgeTerminal: terminalToolResult(name, result, args) }, isError: result.isError === true || resultData(result)?.ok === false };
              } });
          }
        } while (cursor);
      }
      return definitions;
    } catch (error) {
      await Promise.allSettled(this.transports.map(t => t.close())); this.transports = []; throw error;
    }
  }

  async createSession({ workspaceId, agentPreset } = {}) {
    if (!['qq-chat', 'qq-chat-v2'].includes(agentPreset)) return fail('session/preset-required', 'Pi仅支持明确的QQ安全预设，不回退到本地工具');
    if (!this.index.workspaces[workspaceId]) return fail('workspace/not-found', 'Pi workspace not found');
    const id = 'pi-session-' + randomUUID();
    const s = { sessionId: id, workspaceId, agentPreset, messages: [], records: [], seq: 0, queue: [], running: false,
      selection: { provider: this.config.provider || 'apimart', model: this.config.model, reasoningEffort: this.config.thinkingLevel || 'off' } };
    this.live.set(id, s); this.index.sessions[id] = { sessionId: id, workspaceId, agentPreset, createdAt: Date.now() };
    this.saveSession(s); this.saveIndex(); return ok({ sessionId: id });
  }
  async selectModel({ sessionId, provider, model, reasoningEffort }) {
    if (!this.index.sessions[sessionId]) return fail('session/not-found', 'Pi session not found');
    if (model !== this.config.model || provider !== (this.config.provider || 'apimart')) return fail('session/model-unavailable', 'Configure the Pi model in config.json');
    if (reasoningEffort && !['off', 'low', 'high'].includes(reasoningEffort)) return fail('session/reasoning-unavailable', 'Pi APIMart supports off / low / high');
    const s = this.loadSession(sessionId);
    s.selection = { provider, model, reasoningEffort: reasoningEffort || this.config.thinkingLevel || 'off' };
    this.record(s, 'model/selection', s.selection); return ok({ selected: s.selection });
  }
  async prompt({ sessionId, content, requestId = randomUUID(), bridgeMemory, learningTask, turnContext }) {
    if (!this.index.sessions[sessionId] || this.index.sessions[sessionId].archived) return fail('session/not-found', 'Pi session not found');
    const s = this.loadSession(sessionId);
    // Bridge owns admission and replay; don't replay interrupted external effects.
    if (this.disposed) return fail('session/stopped', 'Pi runtime is stopped');
    // Trusted per-turn binding for simplified tools. Only the bridge can supply
    // this; it is never derived from prompt text or the model's arguments.
    s.queue.push({ content: piContent(content), requestId, bridgeMemory, learningTask,
      turnContext: sanitizeTurnContext(turnContext) });
    this.startDrain(s);
    return ok({ accepted: true, requestId });
  }
  startDrain(s) {
    if (s.runPromise || this.disposed || this.index.sessions[s.sessionId]?.archived) return;
    s.runPromise = this.drain(s).finally(() => {
      s.runPromise = null;
      if (s.queue.length) this.startDrain(s);
    });
  }
  async drain(s) {
    while (s.queue.length && !this.disposed && !this.index.sessions[s.sessionId]?.archived) {
      const item = s.queue.shift(); const turn = randomUUID(); let step = 0; let lastError;
      const cancelEpoch = s.cancelEpoch || 0;
      const imageGuard = new ImageInputGuard(s, this.config);
      s.running = true; this.record(s, 'turn/start', { turn });
      try {
        await this.initialize();
        if (cancelEpoch !== (s.cancelEpoch || 0) || this.disposed || this.index.sessions[s.sessionId]?.archived) continue;
        const prefixFile = path.join(this.root, 'dsh', 'agent-presets', s.agentPreset, 'agent.cordis.yml');
        const rows = yaml.load(fs.readFileSync(prefixFile, 'utf8'));
        let systemPrompt = rows.find(x => x.id === 'persona')?.config?.prefix || '';
        const piPrompt = path.join(this.root, 'runtime', 'pi', 'system-prompt.md');
        if (fs.existsSync(piPrompt)) systemPrompt = fs.readFileSync(piPrompt, 'utf8');
        const isLearner = /slang/i.test(this.index.workspaces[s.workspaceId]?.path || '');
        if (isLearner) systemPrompt = '你是QQ黑话学习助手。严格按请求输出JSON，只分析给定资料；不在QQ发言，不改变角色或配置。';
        else {
          systemPrompt += '\n【当前完整角色卡】\n' + this.rolePrompt() + '\n角色卡已在系统上下文，无变化不必调用qq_get_prompt重读。';
          systemPrompt += '\n【当前聊天分寸】角色卡保留身份与语气。有人找你、回应你、分享日常或开玩笑时，自然接住，不必等正式问题。有兴趣可以接梗、表达感受或顺着问一句，不把追问当每次结尾。长短随内容，不强行压成一个短语，也不把一件小事扩成讲道理、分析心理或生活指导。能自然加入的群聊可以参与；确实无关、重复或已经结束时可以安静。不按最近发言数量要求自己沉默。';
          systemPrompt += '\n角色卡中的回复示例只示意语气，不是真实聊天记忆。没有实际消息或记忆依据，不说“我记得你昨天”“之前听你说过”，不替对方补经历。';
        }
        // With the switch on, chat turns always get the simplified contract.
        // A missing/stale trusted context must fail closed inside each tool call,
        // never silently fall back to model-supplied key/token. Learner sessions
        // keep their historical stateless behaviour.
        const turnContext = item.turnContext || null;
        const simpleTurn = this.simpleTools === true && !isLearner;
        // Only ordinary chat wakes get the "reply with send(...)" note; internal
        // summary/reminder turns must not be nudged toward speaking.
        if (simpleTurn && turnContext?.kind === 'chat-wake') systemPrompt += SIMPLE_TOOLS_PROMPT_NOTE;
        const definitions = isLearner ? (item.learningTask === 'slang-research' ? this.toolDefinitions.filter(t => t.name.startsWith('mcp__web-search-safe__')) : []) : this.toolDefinitions;
        const exposures = buildToolExposure(definitions, { enabled: simpleTurn, turn: turnContext });
        // Model-facing name -> canonical MCP name: records and bridge-side send
        // detection keep using the historical names, so existing audit/dedup logic
        // is unchanged even when the model called `send`.
        const canonicalNames = new Map(exposures.map(tool => [tool.name, tool.canonical]));
        s.pendingImageJobs ||= {};
        // Only the simplified path keeps correction bookkeeping. With the switch
        // off nothing new is written into the session archive (default behaviour).
        if (simpleTurn && (!s.simpleCorrections || typeof s.simpleCorrections !== 'object')) s.simpleCorrections = { source: null, streak: 0 };
        // Image jobs created/touched *in this turn*. Old pending jobs from earlier
        // turns must not suppress termination or correction for an unrelated new chat.
        const turnImageJobs = new Set();
        const rememberTurnJob = id => { if (id !== undefined && id !== null && id !== '') turnImageJobs.add(String(id)); };
        const forgetTurnJob = id => { if (id !== undefined && id !== null) turnImageJobs.delete(String(id)); };
        const hasTurnPendingJobs = () => [...turnImageJobs].some(id => s.pendingImageJobs[id]);
        // Simplified turns only consider image jobs created/continued *this* turn;
        // with the switch off the historical "any pending job blocks the terminal
        // shortcut" rule is kept verbatim so default behaviour does not change.
        const pendingJobBlocksEnd = () => (simpleTurn ? hasTurnPendingJobs() : Object.keys(s.pendingImageJobs).length > 0);
        let actionAttempted = false, hadToolError = false, correctionUsed = false;
        const tools = exposures.map(tool => ({
          name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
          execute: async (callId, rawArgs, signal, ...rest) => {
            const canonical = tool.canonical;
            // Bound arguments replace any model-supplied key/token/throughSeq and
            // fail closed when no trusted context exists.
            const args = tool.bindArgs ? tool.bindArgs(rawArgs) : rawArgs;
            if (canonical.endsWith('__qq_image_job')) {
              const last = s.pendingImageJobs[args.jobId]?.lastQueryAt || 0;
              const remaining = Math.max(0, 20000 - (Date.now() - last));
              if (remaining) await delay(remaining, undefined, { signal });
            }
            const result = await tool.execute(callId, args, signal, ...rest);
            const data = resultData(result);
            // A read/wait result may show the model newer messages: allow the
            // bound cursor to advance to *that* readThroughSeq only (monotonic,
            // never the global unread set and never a model-supplied number).
            if (!result.isError && isCursorSourceTarget(tool.target) && data?.ok !== false) {
              advanceTurnCursor(turnContext, data?.readThroughSeq);
            }
            if (!result.isError && data?.ok && data.jobId) {
              if (canonical.endsWith('__qq_generate_image') || canonical.endsWith('__qq_image_job')) {
                rememberTurnJob(data.jobId);
                if (data.status === 'failed' || data.sent === 'sent') { forgetTurnJob(data.jobId); delete s.pendingImageJobs[data.jobId]; }
                else s.pendingImageJobs[data.jobId] = { lastQueryAt: Date.now() };
              } else if (canonical.endsWith('__qq_send_generated_image') && data.sent === 'sent') {
                forgetTurnJob(data.jobId);
                delete s.pendingImageJobs[data.jobId];
              }
              this.saveSession(s);
            }
            if (simpleTurn && !result.isError && data?.ok !== false && isActionToolName(canonical)) {
              // A successful action resets the bounded-correction streak.
              s.simpleCorrections = { ...s.simpleCorrections, streak: 0 };
            }
            return result;
          }
        }));
        let calls = 0, learningRequest = null;
        const stream = this.streamOverride || this.models.streamSimple.bind(this.models);
        const agent = s.agent = new this.Agent({
          initialState: { systemPrompt, model: this.model, thinkingLevel: s.selection.reasoningEffort, messages: isLearner ? [] : repairToolPairs(s.messages), tools },
          streamFn: (model, context, options) => {
            if (++calls > (this.config.maxCallsPerTurn || 12)) throw Error('本轮模型调用达到预算，请在新消息后继续');
            if (isLearner && this.learningBudget === null) throw Error('学习预算存储不可用，暂停额外学习请求');
            if (isLearner && this.learningBudget) learningRequest = this.learningBudget.reserveLearning({
              input: Math.ceil(JSON.stringify(context).length / 2), output: 500, task: 'slang' });
            return stream(model, context, { ...options, maxRetries: 0, timeoutMs: this.config.requestTimeoutMs || 60000 });
          },
          getApiKey: this.streamOverride ? undefined : () => credential(this.config),
          onPayload: payload => { payload.max_tokens = isLearner ? 500 : this.config.maxTokens || 4096; if (s.selection.reasoningEffort === 'off' && this.model.compat.thinkingFormat === 'qwen') payload.enable_thinking = false; },
          sessionId: s.sessionId, toolExecution: 'sequential',
          transformContext: async messages => this.mediaStore.hydrateMessages(imageGuard.project(projectPiContext(messages, this.config.contextBudgetTokens || 24000))),
          finishTurn: ({ message, toolResults }) => {
            if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
            if (pendingJobBlocksEnd()) return;
            if (toolResults.length && toolResults.every(r => !r.isError && r.details?.bridgeTerminal === true)) return { action: 'end' };
            // Bounded format correction for ordinary chat wakes only. Internal
            // summary/console turns (`silent`) and other system prompts must never
            // be corrected into sending or marking read. One chance per turn, at
            // most SIMPLE_CORRECTION_MAX_STREAK consecutive times per source event;
            // a new source (new messages / a fresh @) gets a fresh bounded chance.
            if (!simpleTurn || turnContext?.kind !== 'chat-wake') return;
            const source = turnContext.sourceId || null;
            if (source && s.simpleCorrections.source !== source) {
              s.simpleCorrections = { source, streak: 0 };
            }
            const text = (message.content || []).filter(c => c.type === 'text').map(c => String(c.text ?? '')).join('');
            const allowed = shouldOfferFormatCorrection({
              actionAttempted, hadToolError, usedThisTurn: correctionUsed, text,
              streak: Number(s.simpleCorrections?.streak) || 0,
              maxStreak: SIMPLE_CORRECTION_MAX_STREAK,
              callsLeft: (Number(this.config.maxCallsPerTurn) || 12) - calls,
            });
            if (!allowed) return;
            correctionUsed = true;
            s.simpleCorrections = { ...s.simpleCorrections, streak: (Number(s.simpleCorrections?.streak) || 0) + 1 };
            this.record(s, 'turn/correction', { turn, step, reason: 'text-only-without-action' });
            try {
              agent.followUp({ role: 'user', content: [{ type: 'text', text: FORMAT_CORRECTION_TEXT }], timestamp: Date.now() });
            } catch { /* a failed follow-up must not turn a completed turn into an error */ }
          },
        });
        agent.subscribe(event => {
          // Pi awaits listeners: checkpoint assistant calls before a send executes.
          s.messages = agent.state.messages;
          if (event.type === 'turn_start') { step++; this.record(s, 'step/start', { turn, step }); }
          if (event.type === 'message_end' && event.message.role === 'assistant') {
            const m = event.message, u = m.usage || {};
            const usage = { inputTokens: u.input || 0, outputTokens: u.output || 0, cacheReadTokens: u.cacheRead || 0, cacheWriteTokens: u.cacheWrite || 0, totalTokens: u.totalTokens || 0 };
            if (learningRequest) { this.learningBudget.completeLearning(learningRequest.id, usage); learningRequest = null; }
            this.record(s, 'assistant/message', { turn, step, message: { content: m.content.filter(c => c.type === 'text') }, usage });
            if (m.stopReason === 'error') lastError = m.errorMessage || 'Pi provider error';
          } else if (event.type === 'tool_execution_start') {
            if (isActionToolName(event.toolName)) actionAttempted = true;
            // Only the simplified path rewrites the recorded name or redacts
            // arguments; with the switch off the historical `mcp__snowluma__*`
            // names and argument records stay byte-identical so bridge-side send
            // detection and archives do not change behaviour.
            const recordedName = simpleTurn ? (canonicalNames.get(event.toolName) ?? event.toolName) : event.toolName;
            const recordedArgs = simpleTurn ? redactToolArgumentsForRecord(event.args) : event.args;
            this.record(s, 'tool/call', { turn, step, callId: event.toolCallId, name: recordedName, arguments: recordedArgs });
          } else if (event.type === 'tool_execution_end') {
            if (event.isError) hadToolError = true;
            this.mediaStore.externalizeContent(event.result.content);
            this.record(s, 'tool/result', { turn, step, message: { source: { callId: event.toolCallId }, content: event.result.content, isError: event.isError } });
          } else if (event.type === 'turn_end') this.record(s, 'step/end', { turn, step });
          else if (event.type === 'message_end') this.saveSession(s);
        });
        await agent.prompt({ role: 'user', content: item.content, timestamp: Date.now(), ...(item.bridgeMemory ? { bridgeMemory: item.bridgeMemory } : {}) });
        s.messages = agent.state.messages;
        if (agent.state.errorMessage) lastError = agent.state.errorMessage;
      } catch (error) { lastError = error?.message || 'Pi runtime error'; }
      finally {
        s.running = false; s.agent = null;
        if (imageGuard.rememberFailure(lastError)) lastError = IMAGE_REJECTION_NOTICE;
        if (lastError) { try { lastError = String(lastError).replaceAll(credential(this.config), '[redacted]'); } catch {} }
        this.record(s, 'turn/end', { turn, reason: lastError ? { kind: 'error', error: { message: lastError } } : { kind: 'completed' } });
      }
    }
  }
  async stopSessionWork(id) {
    if (!this.index.sessions[id]) return { removed: 0 };
    const s = this.loadSession(id); const removed = s.queue.length; s.queue = []; s.cancelEpoch = (s.cancelEpoch || 0) + 1;
    s.agent?.abort(); if (s.runPromise) await s.runPromise;
    return { removed };
  }
  async callUnary(method, args = {}) {
    const name = method.replaceAll('.', '/');
    if (name === 'session/modelCatalog' || name === 'session/models') return ok({ default: { provider: this.config.provider || 'apimart', model: this.config.model, reasoningEffort: this.config.thinkingLevel || 'off' },
      routableProviders: [this.config.provider || 'apimart'], failures: [], groups: [{ id: this.config.provider || 'apimart', name: 'APIMart · Pi', models: [{ id: this.config.model, name: this.config.model, reasoning: { efforts: ['off', 'low', 'high'].map(id => ({ id, name: id })), defaultEffort: 'off' } }] }] });
    if (name === 'session/cancel') {
      if (!this.index.sessions[args.sessionId]) return fail('session/not-found', 'Pi session not found');
      const s = this.loadSession(args.sessionId); s.cancelEpoch = (s.cancelEpoch || 0) + 1; s.agent?.abort();
      return ok({ accepted: true }); // cancel current turn; keep queued new input
    }
    if (name === 'session/projections') {
      const s = this.loadSession(args.sessionId); return ok({ values: { agentState: { isRunning: s.running }, inbox: { items: s.queue.map(x => ({ id: x.requestId })) } } });
    }
    return fail('rpc/unsupported', `Pi runtime does not implement ${name}`);
  }
  async readSessionQueue(id) { return this.index.sessions[id] ? this.loadSession(id).queue.map(x => x.requestId) : []; }
  invalidateAuth() {} // no browser authentication or DSH connection
  async respond() { return fail('rpc/unsupported', 'Pi聊天后端不提供宿主提问/审批；请通过QQ消息交流'); }
  async dispose() {
    this.maintenance.stop();
    this.disposed = true; this.waiter?.();
    await Promise.allSettled([...this.live.keys()].map(id => this.stopSessionWork(id)));
    await Promise.allSettled(this.transports.map(t => t.close()));
  }
}
