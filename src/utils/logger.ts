/**
 * 轻量结构化日志：统一日志入口，支持阶段/请求上下文。
 *
 * 原先 console.warn/error 散落各处、格式不一、无上下文。这里给每条日志
 * 附上 scope（模块名）与可选 requestId（一回合请求从进入 pipeline 到
 * 结算完成共用同一个），便于 Web 面板/日志文件串联排查。
 *
 * 级别：debug < info < warn < error。默认 info；LOG_LEVEL=debug 可开全量。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';
}

const seen = new Set<string>();

function log(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  const payload = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  if (level === 'error') console.error(line + payload);
  else if (level === 'warn') console.warn(line + payload);
  else console.log(line + payload);
}

/** 生成短 requestId（一回合一个） */
export function newRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => log('debug', scope, m, e),
    info: (m, e) => log('info', scope, m, e),
    warn: (m, e) => log('warn', scope, m, e),
    error: (m, e) => log('error', scope, m, e),
  };
}

/** 一次性告警（同一 key 只打一次，避免日志风暴） */
export function warnOnce(scope: string, key: string, message: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  log('warn', scope, message);
}
