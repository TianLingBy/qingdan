#!/usr/bin/env node
/**
 * 编号唯一性检查器（迁移号 + 决策号）。
 *
 * 为什么需要它：迁移文件名与 docs/decisions.md 的 D 号都是「全局单序列」，
 * 多个 PR 并行开发时各自取「main 的最大号 + 1」，结构性必然撞号。
 * 2026-11-16 同一时刻四个 PR 抢 0033、三个抢 D87，全部要在合并前重编重跑，
 * 成本由「提交时几秒」放大成「返工半小时 + 一轮 CI」。
 * 本脚本把发现时机从「合并瞬间」提前到「PR 一推上来」。
 *
 * 用法：
 *   node tools/check-numbering.mjs                       # 对比 origin/main
 *   node tools/check-numbering.mjs --base origin/main
 *   node tools/check-numbering.mjs --dir .               # 本地仓库路径
 *
 * 退出码：0 通过；1 撞号（打印应取的号）；2 用法或 git 错误。
 *
 * 命名规则见 docs/DISPATCH-RULES.md §十二。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = 'apps/api/migrations';
const DECISIONS_FILE = 'docs/decisions.md';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg('base', 'origin/main');
const dir = path.resolve(arg('dir', '.'));

function git(args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function lines(text) {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

/** 文件名的两种前缀：老式 4 位顺序号 / 新式 14 位时间戳。 */
function prefixOf(file) {
  const m = /^(\d{4}|\d{14})_/.exec(file);
  return m ? m[1] : null;
}

function baseMigrations() {
  const out = git(['ls-tree', '--name-only', `${base}:${MIGRATIONS_DIR}`]);
  return lines(out).map((p) => path.basename(p));
}

/** base 上每个决策号出现了几次（正常 1 次；用来识别「新增了一条重复号」）。 */
function baseDecisionCounts() {
  const counts = new Map();
  let text;
  try {
    text = git(['show', `${base}:${DECISIONS_FILE}`]);
  } catch {
    return counts;
  }
  for (const line of lines(text)) {
    const m = /^\|\s*(D\d+(?:\.\d+)?)\s*\|/.exec(line);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

function addedFiles() {
  // 两点：本分支相对 base 提交新增的（CI 里就是 PR 的改动）
  const out = git(['diff', '--name-only', '--diff-filter=A', `${base}...HEAD`]);
  return lines(out);
}

/** 磁盘上存在但 base 里没有的迁移文件（本地未提交时也能查出来）。 */
function newMigrationFilesOnDisk() {
  const script = `const fs=require('node:fs');process.stdout.write(JSON.stringify(fs.readdirSync(${JSON.stringify(MIGRATIONS_DIR)}).filter(n=>n.endsWith('.sql'))))`;
  const out = execFileSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8' });
  return JSON.parse(out);
}

const problems = [];
const notes = [];

const baseMigs = baseMigrations();
const basePrefixes = new Map();
for (const f of baseMigs) {
  const p = prefixOf(f);
  if (p) basePrefixes.set(p, f);
}
const maxSequential = Math.max(
  0,
  ...baseMigs.map((f) => {
    const m = /^(\d{4})_/.exec(f);
    return m ? Number(m[1]) : 0;
  }),
);
const lastFile = [...baseMigs].sort((a, b) => a.localeCompare(b)).at(-1) ?? '(空)';

const added = addedFiles();
const commitAddedMigs = added.filter((f) => f.startsWith(`${MIGRATIONS_DIR}/`)).map((f) => path.basename(f));
const diskNewMigs = newMigrationFilesOnDisk().filter((f) => !baseMigs.includes(f));
const addedMigs = [...new Set([...commitAddedMigs, ...diskNewMigs])].sort();

const seenPrefixes = new Map();
for (const f of addedMigs) {
  const p = prefixOf(f);
  if (!p) {
    problems.push(`迁移 ${f} 不符合命名规则：必须以 14 位时间戳（推荐，例 20261116035600_add_xxx.sql）或 4 位顺序号开头`);
    continue;
  }
  if (basePrefixes.has(p)) {
    problems.push(
      `迁移号 ${p} 与 ${base} 上已有的 ${basePrefixes.get(p)} 撞号 → 改用时间戳前缀（YYYYMMDDHHMMSS_xxx.sql），或顺序号改为 ${String(maxSequential + 1).padStart(4, '0')}`,
    );
  }
  if (seenPrefixes.has(p)) {
    problems.push(`迁移号 ${p} 在本 PR 内重复：${seenPrefixes.get(p)} 与 ${f}`);
  }
  seenPrefixes.set(p, f);
  if (p.length === 4 && Number(p) <= maxSequential) {
    problems.push(`迁移号 ${p} 不大于 ${base} 已有的最大号 ${String(maxSequential).padStart(4, '0')} → 执行顺序会错位`);
  }
  if (p.length === 14 && p.localeCompare(lastFile.slice(0, 14)) <= 0) {
    notes.push(`时间戳前缀 ${p} 不晚于现有最后一个文件 ${lastFile}，请确认顺序符合预期`);
  }
}

const baseCounts = baseDecisionCounts();
const baseDs = new Set(baseCounts.keys());
const addedDs = new Map();

// 决策号：按「工作区当前文件里的行」对比 base 的号集合，未提交也能查
let decisionText = '';
try {
  decisionText = readFileSync(path.join(dir, DECISIONS_FILE), 'utf8');
} catch {
  decisionText = '';
}
const workCounts = new Map();
for (const line of lines(decisionText)) {
  const m = /^\|\s*(D\d+(?:\.\d+)?)\s*\|/.exec(line);
  if (!m) continue;
  workCounts.set(m[1], (workCounts.get(m[1]) ?? 0) + 1);
}
for (const [id, count] of workCounts) {
  const before = baseCounts.get(id) ?? 0;
  if (count <= before) continue; // 与 base 一致，不是本轮新增
  if (before > 0) {
    problems.push(`决策号 ${id} 与 ${base} 已有条目撞号 → 顺延到 D${maxDecision(baseDs) + 1}，或找巡检在 issue 里分配`);
  } else if (count - before > 1) {
    problems.push(`决策号 ${id} 在本 PR 内重复 ${count - before} 次`);
  }
  addedDs.set(id, 'new');
}

function maxDecision(set) {
  let max = 0;
  for (const id of set) {
    const n = Number(/D(\d+)/.exec(id)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max;
}

for (const n of notes) console.log(`[note] ${n}`);

if (problems.length === 0) {
  console.log(`[ok] 编号检查通过（base=${base}，main 最大迁移号 ${String(maxSequential).padStart(4, '0')}，最大决策号 D${maxDecision(baseDs)}）`);
  process.exit(0);
}

console.error('[error] 编号撞车，改完再推：');
for (const p of problems) console.error(`  - ${p}`);
console.error(`[hint] 建议：迁移用时间戳前缀（${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_your_change.sql）；决策号找巡检在 issue 里领，当前 main 最大是 D${maxDecision(baseDs)}`);
process.exit(1);
