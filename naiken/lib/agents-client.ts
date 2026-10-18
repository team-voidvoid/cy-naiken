/**
 * Agents REST API, verified against official documentation on 2026-10-18.
 * https://developers.openai.com/api/docs/guides/agents-api/tools/functions
 * https://developers.openai.com/api/reference/resources/beta/subresources/agents/subresources/sessions/methods/create
 * https://developers.openai.com/api/docs/guides/agents-api/sessions/manage
 * API keys stay in the Authorization header; errors never include raw responses.
 */
export interface AgentsConfig {
  apiKey: string;
  model: string;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Can shorten the fixed 20 second ceiling, including for mock tests. */
  timeoutMs?: number;
}
export type SessionStatus = 'idle' | 'in_progress' | 'requires_action' | 'failed';
export type TurnStatus = 'queued' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export interface ResearchRequiredAction {
  type: string;
  turn_id?: string;
  call_id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}
export interface ResearchSession { id: string; status: SessionStatus; required_actions: ResearchRequiredAction[] }
export interface ResearchTurn {
  id: string; session_id: string; status: TurnStatus; created_at: number;
  subagent_id?: string | null; error?: { code: string; message: string } | null;
}
export interface ResearchItem {
  id: string | null; type: string; turn_id: string; role?: string; status?: string;
  phase?: string | null; content?: Array<{ type: string; text?: string }>;
}
export interface ResearchSnapshot {
  sessionStatus: SessionStatus;
  turnId?: string;
  turnStatus?: TurnStatus;
  requiredCalls: Array<{ turnId: string; callId: string; name: string; arguments: Record<string, unknown> }>;
  outputText?: string;
  needsUnsupportedAction: boolean;
  turnErrorCode?: string;
}
export type ToolOutcome = { success: true; output: string } | { success: false; error: string };
export type AgentsErrorCode = 'invalid_request' | 'http_error' | 'timeout' | 'network_error' | 'invalid_response' | 'response_too_large' | 'pagination_limit';
export class AgentsApiError extends Error {
  readonly code: AgentsErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  /** For session creation, this means automatic creation retry is unsafe. */
  readonly outcomeUnknown: boolean;
  apiCode?: string;
  requestId?: string;
  constructor(code: AgentsErrorCode, status?: number, outcomeUnknown = false) {
    const messages: Record<AgentsErrorCode, string> = {
      invalid_request: 'Agents API の設定または入力を確認してください。',
      http_error: `Agents API がエラーを返しました${status ? `（HTTP ${status}）` : ''}。`,
      timeout: 'Agents API の応答が時間内に完了しませんでした。',
      network_error: 'Agents API との通信結果を確認できませんでした。',
      invalid_response: 'Agents API の応答形式を確認できませんでした。',
      response_too_large: 'Agents API の応答サイズが上限を超えました。',
      pagination_limit: 'Agents API の履歴取得が上限に達しました。',
    };
    super(messages[code]); this.name = 'AgentsApiError'; this.code = code; this.status = status; this.outcomeUnknown = outcomeUnknown;
    this.retryable = code === 'timeout' || code === 'network_error' || (code === 'http_error' && (status === 429 || (status ?? 0) >= 500));
  }
}
const API = 'https://api.openai.com/v1/agents/sessions';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 3 * 1024 * 1024;
const MAX_PAGES = 10;
const SESSION_STATUSES = new Set<unknown>(['idle', 'in_progress', 'requires_action', 'failed']);
const TURN_STATUSES = new Set<unknown>(['queued', 'in_progress', 'waiting', 'completed', 'failed', 'cancelled']);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
function idPath(value: string): string { if (!identifier(value)) throw new AgentsApiError('invalid_request'); return encodeURIComponent(value); }
function timeoutMs(config: AgentsConfig): number {
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) throw new AgentsApiError('timeout');
  return Math.min(config.timeoutMs ?? 20_000, 20_000);
}
function remainingConfig(config: AgentsConfig): () => AgentsConfig {
  const deadline = Date.now() + timeoutMs(config);
  return () => ({ ...config, timeoutMs: Math.max(0, deadline - Date.now()) });
}
function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AgentsApiError('timeout'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AgentsApiError('timeout'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.status === 204) return null;
  const advertised = Number(response.headers.get('content-length') ?? 0);
  if (!Number.isFinite(advertised) || advertised < 0 || advertised > MAX_JSON_BYTES) { void response.body?.cancel().catch(() => {}); throw new AgentsApiError('response_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) throw new AgentsApiError('invalid_response');
  let total = 0; let text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_JSON_BYTES) throw new AgentsApiError('response_too_large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw new AgentsApiError('invalid_response'); }
}
async function request(config: AgentsConfig, suffix: string, method = 'GET', payload?: unknown, idempotencyKey?: string, creating = false): Promise<unknown> {
  if (!config.apiKey || /\s/.test(config.apiKey) || !config.model || !suffix.startsWith('/') && suffix !== '') throw new AgentsApiError('invalid_request');
  if (idempotencyKey !== undefined && !/^[\x21-\x7e]{1,256}$/.test(idempotencyKey)) throw new AgentsApiError('invalid_request');
  let body: string | undefined;
  try { body = payload === undefined ? undefined : JSON.stringify(payload); } catch { throw new AgentsApiError('invalid_request'); }
  if (body && new TextEncoder().encode(body).byteLength > MAX_INPUT_BYTES) throw new AgentsApiError('invalid_request');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(config));
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}`, 'OpenAI-Beta': 'agents=v1', Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    // Workers supports follow/manual, but rejects redirect:error before sending.
    // Manual plus the !ok check below also prevents forwarding the API key.
    const response = await withAbort((config.fetcher ?? fetch)(`${API}${suffix}`, { method, headers, body, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' }), controller.signal);
    if (!response.ok) {
      const failure = new AgentsApiError('http_error', response.status, creating && ![400,401,403,404,422,429].includes(response.status));
      const requestId = response.headers.get('x-request-id');
      if (requestId && /^[A-Za-z0-9_-]{1,100}$/.test(requestId)) failure.requestId = requestId;
      // Keep only machine-readable identifiers. Never persist API error prose or headers.
      try {
        const data = await readJson(response, controller.signal);
        if (record(data) && record(data.error) && typeof data.error.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(data.error.code)) failure.apiCode = data.error.code;
      } catch { /* The HTTP status remains useful even if its body is unavailable. */ }
      throw failure;
    }
    // Events return HTTP 202 acceptance without a JSON response body.
    if (method === 'POST' && suffix.endsWith('/events')) { void response.body?.cancel().catch(() => {}); return null; }
    return await readJson(response, controller.signal);
  } catch (error) {
    if (error instanceof AgentsApiError) {
      if (creating && error.code !== 'http_error') throw new AgentsApiError(error.code, error.status, true);
      throw error;
    }
    throw new AgentsApiError(controller.signal.aborted ? 'timeout' : 'network_error', undefined, creating);
  } finally { clearTimeout(timer); }
}
function parseSession(value: unknown): ResearchSession {
  if (!record(value) || !identifier(value.id) || !SESSION_STATUSES.has(value.status) || !Array.isArray(value.required_actions)) throw new AgentsApiError('invalid_response');
  const actions = value.required_actions.map((action): ResearchRequiredAction => {
    if (!record(action) || typeof action.type !== 'string') throw new AgentsApiError('invalid_response');
    if (action.type !== 'function_call') return { type: action.type };
    if (!identifier(action.turn_id) || !identifier(action.call_id) || typeof action.name !== 'string' || !record(action.arguments)) throw new AgentsApiError('invalid_response');
    return { type: action.type, turn_id: action.turn_id, call_id: action.call_id, name: action.name, arguments: action.arguments };
  });
  return { id: value.id, status: value.status as SessionStatus, required_actions: actions };
}
function parseTurn(value: unknown): ResearchTurn {
  if (!record(value) || !identifier(value.id) || !identifier(value.session_id) || !TURN_STATUSES.has(value.status) || typeof value.created_at !== 'number' || (value.subagent_id !== undefined && value.subagent_id !== null && !identifier(value.subagent_id))) throw new AgentsApiError('invalid_response');
  let error: ResearchTurn['error'];
  if (value.error != null) {
    if (!record(value.error) || typeof value.error.code !== 'string') throw new AgentsApiError('invalid_response');
    // A generic message avoids accidentally forwarding model/service output.
    error = { code: /^[a-z_]{1,80}$/.test(value.error.code) ? value.error.code : 'unknown_error', message: 'Agent の調査ターンが失敗しました。' };
  }
  return { id: value.id, session_id: value.session_id, status: value.status as TurnStatus, created_at: value.created_at, subagent_id: value.subagent_id as string | null | undefined, error };
}
function parseItem(value: unknown): ResearchItem {
  if (!record(value) || (value.id !== null && !identifier(value.id)) || typeof value.type !== 'string' || !identifier(value.turn_id)) throw new AgentsApiError('invalid_response');
  const item: ResearchItem = { id: value.id as string | null, type: value.type, turn_id: value.turn_id };
  if (value.type === 'message') {
    if (!Array.isArray(value.content) || typeof value.role !== 'string' || typeof value.status !== 'string' || (value.phase !== null && typeof value.phase !== 'string')) throw new AgentsApiError('invalid_response');
    item.role = value.role; item.status = value.status; item.phase = value.phase;
    item.content = value.content.map((part) => {
      if (!record(part) || typeof part.type !== 'string' || (part.type === 'output_text' && typeof part.text !== 'string')) throw new AgentsApiError('invalid_response');
      return { type: part.type, ...(typeof part.text === 'string' ? { text: part.text } : {}) };
    });
  }
  return item;
}
async function listAll<T>(config: AgentsConfig, suffix: string, parse: (item: unknown) => T): Promise<T[]> {
  const nextConfig = remainingConfig(config); const items: T[] = []; const cursors = new Set<string>(); let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ order: 'asc', limit: '100', ...(after ? { after } : {}) });
    const result = await request(nextConfig(), `${suffix}?${query}`);
    if (!record(result) || !Array.isArray(result.data) || typeof result.has_more !== 'boolean') throw new AgentsApiError('invalid_response');
    items.push(...result.data.map(parse));
    if (!result.has_more) return items;
    if (!identifier(result.last_id) || cursors.has(result.last_id) || result.data.length === 0) throw new AgentsApiError('invalid_response');
    after = result.last_id; cursors.add(after);
  }
  throw new AgentsApiError('pagination_limit');
}

/** Never retry this automatically: an unknown creation result may already be running. */
export async function createResearchSession(config: AgentsConfig, instructions: string, input: string, outputSchema: object): Promise<string> {
  if (!input.trim() || !record(outputSchema)) throw new AgentsApiError('invalid_request');
  const result = await request(config, '', 'POST', {
    agent: { model: config.model, instructions, multi_agent: { enabled: false },
      text: { format: { type: 'json_schema', schema: outputSchema } },
      tools: [
        { type: 'web_search', context_size: 'low', mode: 'live' },
        { type: 'function', name: 'inspect_public_page', description: 'Read one public HTML page and return bounded public observations and text. No login, form submission, script execution or private network access.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
      ],
    }, environment: { type: 'none' }, input, stream: false,
  }, undefined, true);
  if (!record(result) || !identifier(result.id)) throw new AgentsApiError('invalid_response', undefined, true);
  return result.id;
}
export async function getResearchSession(config: AgentsConfig, sessionId: string): Promise<ResearchSession> {
  const result = parseSession(await request(config, `/${idPath(sessionId)}`));
  if (result.id !== sessionId) throw new AgentsApiError('invalid_response');
  return result;
}
export async function getResearchTurn(config: AgentsConfig, sessionId: string, turnId: string): Promise<ResearchTurn> {
  const result = parseTurn(await request(config, `/${idPath(sessionId)}/turns/${idPath(turnId)}`));
  if (result.id !== turnId || result.session_id !== sessionId) throw new AgentsApiError('invalid_response');
  return result;
}
export async function listResearchTurns(config: AgentsConfig, sessionId: string): Promise<ResearchTurn[]> {
  const turns = await listAll(config, `/${idPath(sessionId)}/turns`, parseTurn);
  if (turns.some((turn) => turn.session_id !== sessionId)) throw new AgentsApiError('invalid_response');
  return turns;
}
export async function listResearchItems(config: AgentsConfig, sessionId: string, turnId?: string): Promise<ResearchItem[]> {
  if (turnId) idPath(turnId);
  const items = await listAll(config, `/${idPath(sessionId)}/items`, parseItem);
  return turnId ? items.filter((item) => item.turn_id === turnId) : items;
}
/** Persist this exact key and output before sending; reuse both after a lost response. */
export async function submitToolOutput(config: AgentsConfig, sessionId: string, action: { turnId: string; callId: string }, outcome: ToolOutcome, idempotencyKey: string): Promise<void> {
  idPath(action.turnId); idPath(action.callId);
  if (!idempotencyKey || (outcome.success ? typeof outcome.output !== 'string' : typeof outcome.error !== 'string')) throw new AgentsApiError('invalid_request');
  await request(config, `/${idPath(sessionId)}/events`, 'POST', { events: [{ type: 'agent.session.input.tool_result', turn_id: action.turnId, call_id: action.callId, ...(outcome.success ? { success: true, output: outcome.output } : { success: false, error: outcome.error }) }] }, idempotencyKey);
}
export async function cancelResearchSession(config: AgentsConfig, sessionId: string, idempotencyKey: string): Promise<void> {
  if (!idempotencyKey) throw new AgentsApiError('invalid_request');
  await request(config, `/${idPath(sessionId)}/events`, 'POST', { events: [{ type: 'agent.session.input.cancel' }] }, idempotencyKey);
}
/** Delete only after saving the required output; deletion removes API history. */
export async function deleteResearchSession(config: AgentsConfig, sessionId: string): Promise<void> {
  await request(config, `/${idPath(sessionId)}`, 'DELETE');
}
export async function getResearchSnapshot(config: AgentsConfig, sessionId: string, turnId?: string): Promise<ResearchSnapshot> {
  const nextConfig = remainingConfig(config);
  const [session, turns] = await Promise.all([getResearchSession(nextConfig(), sessionId), turnId ? getResearchTurn(nextConfig(), sessionId, turnId).then((turn) => [turn]) : listResearchTurns(nextConfig(), sessionId)]);
  const rootTurns = turns.filter((turn) => !turn.subagent_id);
  if (turnId && rootTurns.length !== 1) throw new AgentsApiError('invalid_response');
  // This client creates exactly one turn; do not silently adopt a later task.
  if (!turnId && rootTurns.length > 1) throw new AgentsApiError('invalid_response');
  const turn = rootTurns[0];
  const snapshot: ResearchSnapshot = { sessionStatus: session.status, turnId: turn?.id, turnStatus: turn?.status, requiredCalls: [], needsUnsupportedAction: false, turnErrorCode: turn?.error?.code };
  for (const action of session.required_actions) {
    if (action.type !== 'function_call' || action.name !== 'inspect_public_page') { snapshot.needsUnsupportedAction = true; continue; }
    if (!turn) continue;
    if (action.turn_id !== turn.id) { snapshot.needsUnsupportedAction = true; continue; }
    snapshot.requiredCalls.push({ turnId: action.turn_id!, callId: action.call_id!, name: action.name, arguments: action.arguments! });
  }
  if (turn?.status === 'completed' && session.status !== 'failed') {
    const items = await listResearchItems(nextConfig(), sessionId, turn.id);
    const finals = items.filter((item) => item.type === 'message' && item.role === 'assistant' && item.phase === 'final_answer' && item.status === 'completed');
    if (finals.length === 1) snapshot.outputText = finals[0].content?.filter((part) => part.type === 'output_text').map((part) => part.text).join('');
  }
  return snapshot;
}
