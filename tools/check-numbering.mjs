#!/usr/bin/env node
/**
 * 编号唯一性检查：迁移号（apps/api/migrations/*.sql）+ 决策号（docs/decisions.md）。
 *
 * 功能
 *   对比 base 分支，检查本分支新增的迁移文件与决策行有没有撞号、号有没有倒挂、命名合不合规。
 *   撞了直接打印「你该用哪个号」，并把退出码置 1，让 PR 一推上来就红，而不是等合并时人肉发现。
 *
 * 原理
 *   1. 迁移号看文件名前缀：老的 4 位顺序号（`0033_`）或新的 14 位时间戳（`20261116043000_`）。
 *      base 的前缀集合与最大顺序号从 `git ls-tree <base>:apps/api/migrations` 取；
 *      本分支的文件从磁盘读——CI 里工作区就是 PR 的 checkout，本地未提交也能查。
 *   2. 决策号看 `| D<n> | ... |` 表格行的出现次数：本分支次数多于 base，说明新增了一行；
 *      新增的号若 base 已有 → 撞号；同一号新增超过一次 → PR 内部重复。
 *   3. 为什么这样判：迁移与决策都是全局单序列，多 PR 并行各自取「main 最大值 + 1」必然撞，
 *      唯一性能交给时间（迁移）与巡检分配（决策号），顺序性交给 `localeCompare` 与递增校验。
 *      详见 docs/DISPATCH-RULES.md §十二。
 *
 * 用法
 *   node tools/check-numbering.mjs                    # 对比 origin/main
 *   node tools/check-numbering.mjs --base <ref>       # 换基线
 *   node tools/check-numbering.mjs --dir <repo>       # 换仓库根
 *
 * 退出码：0 通过；1 撞号或不合规；2 用法错误。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = 'apps/api/migrations';
const DECISIONS_FILE = 'docs/decisions.md';
const DECISION_ROW = /^\|\s*(D\d+(?:\.\d+)?)\s*\|/; // 表格首列即决策号
const MIGRATION_ID = /^(\d{4}|\d{14})_/; // 4 位顺序号（存量）或 14 位时间戳（新规矩）

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const base = option('base', 'origin/main');
const repo = path.resolve(option('dir', '.'));

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const lines = (text) => text.split(/\r?\n/).filter((line) => line.trim() !== '');
const decisionId = (line) => DECISION_ROW.exec(line)?.[1] ?? null;

/** base 上的迁移文件名。 */
function baseMigrations() {
  return lines(git(['ls-tree', '--name-only', `${base}:${MIGRATIONS_DIR}`])).map((p) => path.basename(p));
}

/** 磁盘上的迁移文件名（CI 里等于 PR 的 checkout，本地含未提交文件）。 */
function diskMigrations() {
  return readdirSync(path.join(repo, MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql'));
}

/** base 上每个决策号出现几次。 */
function baseDecisionCounts() {
  const counts = new Map();
  for (const line of lines(git(['show', `${base}:${DECISIONS_FILE}`]))) {
    const id = decisionId(line);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** 工作区每个决策号出现几次。 */
function diskDecisionCounts() {
  const counts = new Map();
  let text = '';
  try {
    text = readFileSync(path.join(repo, DECISIONS_FILE), 'utf8');
  } catch {
    return counts; // 文件不存在就当没有决策行
  }
  for (const line of lines(text)) {
    const id = decisionId(line);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

const decisionNumber = (id) => Number(/D(\d+)/.exec(id)?.[1] ?? 0);
const highestDecision = (ids) => Math.max(0, ...[...ids].map(decisionNumber));
const pad4 = (n) => String(n).padStart(4, '0');
// 本地时间戳：仓库单时区协作，用本地钟更贴合「几点改的」直觉；只要恒用同一种口径，顺序即正确
const stamp = () => {
  const now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
};

const problems = [];
const notes = [];

// ---------- 迁移号 ----------
const baseMigs = baseMigrations();
const basePrefixes = new Map(); // 前缀 → base 上的文件名，用来报「跟谁撞了」
let maxSequential = 0;
for (const file of baseMigs) {
  const prefix = MIGRATION_ID.exec(file)?.[1];
  if (!prefix) continue;
  basePrefixes.set(prefix, file);
  if (prefix.length === 4) maxSequential = Math.max(maxSequential, Number(prefix));
}
const lastMigration = [...baseMigs].sort((a, b) => a.localeCompare(b)).at(-1) ?? '';

const newMigs = diskMigrations().filter((file) => !baseMigs.includes(file)).sort();
const seenPrefix = new Map();
for (const file of newMigs) {
  const prefix = MIGRATION_ID.exec(file)?.[1];
  if (!prefix) {
    problems.push(`${file} 命名不合规：需以 14 位时间戳（例 ${stamp()}_your_change.sql）或 4 位顺序号开头`);
    continue;
  }
  if (basePrefixes.has(prefix)) {
    problems.push(`${prefix} 撞号：${base} 已有 ${basePrefixes.get(prefix)} → 改时间戳前缀，或顺序号用 ${pad4(maxSequential + 1)}`);
  }
  if (seenPrefix.has(prefix)) {
    problems.push(`${prefix} 在本分支内重复：${seenPrefix.get(prefix)} 与 ${file}`);
  }
  seenPrefix.set(prefix, file);
  if (prefix.length === 4 && Number(prefix) <= maxSequential) {
    problems.push(`${prefix} 不大于 ${base} 的最大顺序号 ${pad4(maxSequential)} → 执行顺序会倒挂`);
  }
  if (prefix.length === 14 && prefix.localeCompare(lastMigration.slice(0, 14)) <= 0) {
    notes.push(`时间戳 ${prefix} 不晚于现有最后一个迁移 ${lastMigration}，确认顺序符合预期`);
  }
}

// ---------- 决策号 ----------
const baseCounts = baseDecisionCounts();
let diskCounts;
try {
  diskCounts = diskDecisionCounts();
} catch {
  diskCounts = new Map();
}
const highest = highestDecision(baseCounts.keys());
for (const [id, count] of diskCounts) {
  const added = count - (baseCounts.get(id) ?? 0);
  if (added <= 0) continue; // 与 base 一致，不是本分支新增
  if (baseCounts.has(id)) {
    problems.push(`${id} 撞号：${base} 已有该条目 → 顺延到 D${highest + 1}，或找巡检在 issue 里分配`);
  } else if (added > 1) {
    problems.push(`${id} 在本分支内出现 ${added} 次`);
  }
}

for (const note of notes) console.log(`[note] ${note}`);

if (problems.length === 0) {
  console.log(`[ok] 编号检查通过（base=${base}；迁移最大顺序号 ${pad4(maxSequential)}，决策最大号 D${highest}）`);
  process.exit(0);
}

console.error('[error] 编号有问题，改完再推：');
for (const problem of problems) console.error(`  - ${problem}`);
console.error(`[hint] 迁移用时间戳前缀（${stamp()}_your_change.sql）；决策号找巡检领，当前 main 最大 D${highest}`);
process.exit(1);
