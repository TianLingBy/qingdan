/**
 * 无依赖的 JSON → YAML 序列化器（只覆盖 OpenAPI 文档实际出现的 JSON 值类型）。
 *
 * 设计目标：输出稳定、可 diff（键按插入顺序、2 空格缩进、数组用 `- ` 块），
 * 且不需要引入第三方 YAML 依赖。字符串统一用双引号转义（含换行时输出 `\n`，
 * 不使用 `|` 块标量），避免块标量对缩进/尾随空行的隐式规则。
 */

type JsonObject = Record<string, unknown>;

/** YAML 视为 null 的裸词。 */
const NULL_LIKE = /^(?:~|null)$/i;
/** YAML 1.1 / 1.2 视为布尔的裸词。 */
const BOOL_LIKE = /^(?:true|false|yes|no|on|off|y|n)$/i;
/** 会被解析成数字的写法（含 0x / 0o / 0b / .inf / .nan）。 */
const NUMBER_LIKE =
  /^[-+]?(?:\.inf|\.nan|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/;
/** 会被解析成时间戳的日期写法。 */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/;
/** 位于行首时具有 YAML 语法含义的指示符。 */
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
/** 是否含控制字符（含换行、制表符），这些字符必须走双引号转义。 */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** 空对象 / 空数组（写成 `{}` / `[]` 单行形式）。 */
function isEmptyCollection(value: unknown): boolean {
  return (
    (Array.isArray(value) && value.length === 0) ||
    (isJsonObject(value) && Object.keys(value).length === 0)
  );
}

/** 字符串（或 mapping key）是否必须加双引号。 */
function needsQuote(value: string): boolean {
  return (
    value === '' ||
    hasControlChar(value) ||
    value !== value.trim() ||
    INDICATOR_START.test(value) ||
    value.includes(':') ||
    value.includes('#') ||
    NULL_LIKE.test(value) ||
    BOOL_LIKE.test(value) ||
    NUMBER_LIKE.test(value) ||
    DATE_LIKE.test(value)
  );
}

/** 双引号转义，保证输出中不出现裸 tab / 裸换行。 */
function quote(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`YAML 不支持非有限数字：${String(value)}`);
    return String(value);
  }
  return needsQuote(value) ? quote(value) : value;
}

function formatKey(key: string): string {
  return needsQuote(key) ? quote(key) : key;
}

function pad(indent: number): string {
  return ' '.repeat(indent);
}

function emitObject(value: JsonObject, indent: number): string {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const head = `${pad(indent)}${formatKey(key)}:`;
    if (isScalar(child)) {
      lines.push(`${head} ${scalar(child)}`);
    } else if (isEmptyCollection(child)) {
      lines.push(`${head} ${Array.isArray(child) ? '[]' : '{}'}`);
    } else {
      lines.push(`${head}\n${emitValue(child, indent + 2)}`);
    }
  }
  return lines.join('\n');
}

function emitArray(value: unknown[], indent: number): string {
  const lines: string[] = [];
  const prefix = `${pad(indent)}- `;
  for (const child of value) {
    if (isScalar(child)) {
      lines.push(`${prefix}${scalar(child)}`);
    } else if (isEmptyCollection(child)) {
      lines.push(`${prefix}${Array.isArray(child) ? '[]' : '{}'}`);
    } else if (isJsonObject(child)) {
      // 对象数组：首个键跟在 `- ` 后，其余键与首个键对齐（缩进 indent + 2）。
      const childLines = emitObject(child, indent + 2).split('\n');
      childLines[0] = `${prefix}${childLines[0]!.slice(indent + 2)}`;
      lines.push(childLines.join('\n'));
    } else {
      // 嵌套数组（OpenAPI 文档中极少见）：`-` 单独一行，子块再缩进 2 格。
      lines.push(`${pad(indent)}-\n${emitValue(child, indent + 2)}`);
    }
  }
  return lines.join('\n');
}

function emitValue(value: unknown, indent: number): string {
  if (isScalar(value)) return `${pad(indent)}${scalar(value)}`;
  if (Array.isArray(value)) return emitArray(value, indent);
  if (isJsonObject(value)) return emitObject(value, indent);
  throw new Error(`YAML 序列化不支持的类型：${Object.prototype.toString.call(value)}`);
}

/** 把 JSON 值序列化为 YAML 文本（末尾带一个换行）。 */
export function toYaml(value: unknown): string {
  return `${emitValue(value, 0)}\n`;
}
