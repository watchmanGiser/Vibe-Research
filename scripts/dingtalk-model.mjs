/** 有界模型调用：实时采集用量；终止整个本机进程组；未知用量不记为零。 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { normalizedUsage } from './dingtalk-jobs.mjs';
import { assertUpdateWindow, updateDeadline } from './dingtalk-schedule.mjs';

const modelError = code => Object.assign(Error(`整理模型调用失败（${code}）`), { code });
export async function callCodex({ bin, args, input, timeout, signal, ledger, jobId, model, reasoning, killGrace = 1500 }) {
  assertUpdateWindow();
  timeout = Math.max(1, updateDeadline(timeout) - Date.now());
  const callId = ledger.start(jobId, { transport: 'codex', model: model || 'cli-default', reasoning: reasoning || 'cli-default' });
  const started = Date.now();
  let usage = null, failure = null, stderrCode = null, child, cleanup, stopped = false, requestIds = new Set();
  const recordUsage = raw => {
    const next = normalizedUsage(raw); if (!next) return;
    usage = usage ? { ...next, inputTokens: usage.inputTokens + next.inputTokens, outputTokens: usage.outputTokens + next.outputTokens,
      cachedInputTokens: usage.cachedInputTokens + next.cachedInputTokens, totalTokens: usage.totalTokens + next.totalTokens,
      raw: [...(Array.isArray(usage.raw) ? usage.raw : [usage.raw]), next.raw] } : next;
    ledger.append({ event: 'usage', callId, usage, usageStatus: 'partial' });
  };
  try {
    await new Promise((resolve, reject) => {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      let buffer = '', closed = false, status = null;
      const kill = kind => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, kind); } catch (e) { if (e.code !== 'ESRCH') failure ||= 'KILL_FAILED'; } };
      const finish = () => {
        if (!closed || cleanup) return;
        if (failure || status !== 0) reject(modelError(failure || stderrCode || 'MODEL_EXIT'));
        else resolve();
      };
      const stop = code => {
        if (stopped) return; stopped = true; failure = code; kill('SIGTERM');
        // 即使父进程先退出，也要等待并清理仍存活的后代进程。
        cleanup = setTimeout(() => { kill('SIGKILL'); cleanup = null; finish(); }, killGrace);
      };
      const abort = () => stop('INTERRUPTED');
      const timer = setTimeout(() => stop('MODEL_TIMEOUT'), Math.max(1, timeout));
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.on('error', () => { failure ||= 'MODEL_SPAWN'; closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); finish(); });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 1024 * 1024) { stop('MODEL_OUTPUT_LIMIT'); return; }
        for (let end; (end = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          try {
            if (event.type === 'turn.completed') recordUsage(event.usage);
            for (const id of [event.request_id, event.response_id]) if (typeof id === 'string' && /^[\w.:-]{1,160}$/.test(id)) requestIds.add(id);
            if (event.type === 'turn.failed') failure ||= 'MODEL_TURN_FAILED';
          } catch { stop('LEDGER_WRITE'); }
        }
      });
      child.stderr.on('data', chunk => {
        const text = chunk.toString('utf8');
        if (/\b429\b/.test(text)) stderrCode ||= 'RATE_LIMIT';
        else if (/\b50[0234]\b/.test(text)) stderrCode ||= 'UPSTREAM_ERROR';
        else if (/\b40[13]\b/.test(text)) stderrCode ||= 'MODEL_AUTH';
      });
      child.on('close', (code, termSignal) => { status = code; closed = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); finish(); });
      if (signal?.aborted) abort();
      else child.stdin.end(input);
    });
    ledger.append({ event: 'finished', callId, success: true, durationMs: Date.now() - started,
      usage, usageStatus: usage ? 'reported' : 'unknown', requestIds: [...requestIds] });
  } catch (error) {
    ledger.append({ event: 'finished', callId, success: false, errorCode: error.code || 'MODEL_FAILED', durationMs: Date.now() - started,
      usage, usageStatus: usage ? 'partial' : 'unknown', requestIds: [...requestIds] });
    throw error;
  }
}

export async function callResponses({ endpoint, apiKey, model, reasoning, input, images, schema, timeout, signal, ledger, jobId }) {
  assertUpdateWindow();
  timeout = Math.max(1, updateDeadline(timeout) - Date.now());
  let url;
  try { url = new URL(endpoint); } catch { throw modelError('MODEL_CONFIG'); }
  if (url.username || url.password || url.search || url.hash) throw modelError('MODEL_CONFIG');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw modelError('MODEL_CONFIG');
  const callId = ledger.start(jobId, { transport: 'responses', model, reasoning });
  const started = Date.now(); let usage = null, requestId = null;
  try {
  const content = [{ type: 'input_text', text: input }, ...images.map(file => {
    const extension = file.split('.').at(-1), mime = extension === 'jpg' ? 'jpeg' : extension;
    return { type: 'input_image', image_url: `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}` };
  })];
    const response = await fetch(url, { method: 'POST', signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: [{ role: 'user', content }], reasoning: { effort: reasoning }, max_output_tokens: 12000,
        text: { format: { type: 'json_schema', name: 'dingtalk_summary', strict: true, schema } }, store: false }) });
    const id = response.headers.get('x-request-id'); if (id && /^[\w.:-]{1,160}$/.test(id)) requestId = id;
    if (!response.ok) throw modelError(response.status === 429 ? 'RATE_LIMIT' : [401, 403].includes(response.status) ? 'MODEL_AUTH' : 'UPSTREAM_ERROR');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 512 * 1024) { throw modelError('MODEL_OUTPUT_LIMIT'); }
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); usage = normalizedUsage(result.usage, 'responses');
    const text = result.output?.flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
    if (!text || result.status === 'incomplete') throw modelError('MODEL_INCOMPLETE');
    ledger.append({ event: 'finished', callId, success: true, durationMs: Date.now() - started, usage,
      usageStatus: usage ? 'reported' : 'unknown', requestIds: requestId ? [requestId] : [] });
    return text;
  } catch (error) {
    const code = error.name === 'TimeoutError' ? 'MODEL_TIMEOUT' : error.name === 'AbortError' ? 'INTERRUPTED' : error.code || 'MODEL_FAILED';
    ledger.append({ event: 'finished', callId, success: false, durationMs: Date.now() - started, errorCode: code,
      usage, usageStatus: usage ? 'reported' : 'unknown', requestIds: requestId ? [requestId] : [] });
    throw modelError(code);
  }
}
