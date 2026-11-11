/** 来源仅取自安装记录、锁文件及元数据，不按目录名称猜测。 */
import { open, stat, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { InstallSource, RootView, SkillProvenance } from "./types.js";
interface LockIndex { entries: Record<string, unknown> }
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 2048;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
type Fingerprint = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number };
type CachedJson = { fingerprint: Fingerprint; value: unknown; bytes: number };
const jsonCache = new Map<string, CachedJson>();
let cacheBytes = 0;
function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev;
}
function evict(file: string): void {
  const cached = jsonCache.get(file);
  if (cached) { cacheBytes -= cached.bytes; jsonCache.delete(file); }
}
async function readJson(file: string): Promise<unknown> {
  let info;
  try { info = await stat(file); } catch (error) { evict(file); throw error; }
  if (!info.isFile() || info.size > MAX_JSON_BYTES) { evict(file); return null; }
  const cached = jsonCache.get(file);
  if (cached && sameFile(cached.fingerprint, info)) {
    jsonCache.delete(file); jsonCache.set(file, cached);
    return cached.value;
  }
  evict(file);
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_JSON_BYTES) return null;
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > opened.size) return null;
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, length).toString("utf8")); } catch { value = null; }
    const after = await handle.stat();
    const current = await stat(file).catch(() => null);
    if (current && sameFile(opened, after) && sameFile(after, current)) {
      evict(file);
      while (jsonCache.size >= MAX_CACHE_ENTRIES || cacheBytes + length > MAX_CACHE_BYTES) {
        const oldest = jsonCache.keys().next().value;
        if (oldest === undefined) break;
        evict(oldest);
      }
      jsonCache.set(file, { fingerprint: after, value, bytes: length });
      cacheBytes += length;
    }
    return value;
  } finally { await handle.close(); }
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const PERSISTENT_MAPPING_PATH = join(homedir(), ".dsh", "skills-manager", "provenance-mapping.json");

async function readPersistentMapping(): Promise<Record<string, unknown>> {
  try {
    const parsed = object(await readJson(PERSISTENT_MAPPING_PATH));
    const mappings = object(parsed?.mappings ?? parsed?.skills ?? parsed);
    return mappings || {};
  } catch {
    return {};
  }
}

async function readLockIndex(rootPath: string): Promise<LockIndex | null> {
  try {
    const parsed = object(await readJson(join(rootPath, ".skills-lock.json")));
    const entries = object(parsed?.skills ?? parsed);
    if (entries) return { entries };
  } catch { /* 尝试兜底锁文件 */ }

  // 针对 ~/.agents/skills 等标准来源目录，当没有 .skills-lock.json 时，探测同级或父级 .skill-lock.json (npx skills)
  if (basename(rootPath) === "skills" || rootPath.includes(".agents")) {
    const fallbacks = [
      join(dirname(rootPath), ".skill-lock.json"),
      join(dirname(rootPath), ".skills-lock.json"),
      join(rootPath, ".skill-lock.json"),
      PERSISTENT_MAPPING_PATH,
    ];
    for (const file of fallbacks) {
      try {
        const parsed = object(await readJson(file));
        const entries = object(parsed?.skills ?? parsed?.mappings ?? parsed);
        if (entries) return { entries };
      } catch { /* 继续探测 */ }
    }
  }

  return null;
}

function segments(path: string): string[] { return path.split(/[\/]+/).filter(Boolean); }
export function categoryOfRepoPath(skillPath: string | null | undefined, subdirectory?: string | null): string | null {
  if (!skillPath) return null;
  const parts = segments(skillPath);
  if (parts.length && /^skill\.md$/i.test(parts[parts.length - 1])) parts.pop();
  const sub = subdirectory ? segments(subdirectory) : [];
  if (sub.length && sub.every((part, i) => parts[i] === part)) parts.splice(0, sub.length);
  else if (parts[0] === "skills") parts.shift();
  return parts.length >= 2 ? parts[0] : null;
}
function sourceInfo(raw: unknown, githubShorthand: boolean): { repo: string; identity: string; url: string | null } | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\x00-\x1f]/.test(value)) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(value) && githubShorthand) {
    const repo = value.replace(/\.git$/i, "");
    if (repo.split("/").some(x => x === "." || x === "..")) return null;
    const url = `https://github.com/${repo}`;
    return { repo, identity: url.toLowerCase(), url };
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname === "/") return null;
    const normalized = parsed.href.replace(/\/$/, "").replace(/\.git$/i, "");
    const identity = parsed.hostname === "github.com" ? normalized.toLowerCase() : normalized;
    return { repo: `${parsed.hostname}${parsed.pathname.replace(/\/$/, "").replace(/\.git$/i, "")}`, identity, url: parsed.protocol === "https:" ? normalized : null };
  } catch { return null; }
}
function fromInstallSource(source: InstallSource): SkillProvenance | null {
  const info = sourceInfo(source.url || (source.owner && source.name ? `${source.owner}/${source.name}` : null), !source.url)
    ?? (typeof source.url === "string" && (/^[a-zA-Z]:[\\\\/]/.test(source.url) || source.url.startsWith("/")) && !/[\x00-\x1f]/.test(source.url)
      ? { repo: `${source.owner}/${source.name}`, identity: source.url, url: null } : null);
  if (!info) return null;
  const skillPath = typeof source.path === "string" && source.path ? source.path : null;
  return { kind: "install", ...info, repo: source.owner && source.name ? `${source.owner}/${source.name}` : info.repo,
    category: categoryOfRepoPath(skillPath, typeof source.subdirectory === "string" ? source.subdirectory : null), path: skillPath };
}
function fromLockEntry(value: unknown): SkillProvenance | null {
  const entry = object(value);
  if (!entry) return null;
  const isGh = entry.sourceType === "github" || (typeof entry.sourceUrl === "string" && entry.sourceUrl.includes("github.com")) || (typeof entry.url === "string" && entry.url.includes("github.com"));
  const rawSource = (typeof entry.source === "string" ? entry.source : null) || (typeof entry.sourceUrl === "string" ? entry.sourceUrl : null) || (typeof entry.repo === "string" ? entry.repo : null);
  const info = sourceInfo(rawSource, isGh);
  if (!info) return null;
  const path = typeof entry.skillPath === "string" && entry.skillPath ? entry.skillPath : null;
  return { kind: "lock", ...info, category: categoryOfRepoPath(path), path };
}
async function fromMarketMeta(skillDir: string): Promise<SkillProvenance | null> {
  for (const name of ["_skillhub_meta.json", "_meta.json"]) {
    try {
      const metadata = object(await readJson(join(skillDir, name)));
      const info = sourceInfo(metadata?.source, metadata?.sourceType === "github");
      if (info) return { kind: "meta", ...info, category: null, path: null };
    } catch { /* 尝试下一证据 */ }
  }
  return null;
}

// 常见生态权威知名仓库映射表
const CURATED_ECOSYSTEM_RULES: Array<{ match: (name: string) => boolean; repo: string; url: string }> = [
  { match: (n) => n.startsWith("dbs-") || n === "dbs", repo: "dontbesilent2025/dbskill", url: "https://github.com/dontbesilent2025/dbskill" },
  { match: (n) => n.startsWith("tavily-"), repo: "tavily-ai/skills", url: "https://github.com/tavily-ai/skills" },
  { match: (n) => n.startsWith("obsidian-") || n === "defuddle" || n === "json-canvas", repo: "kepano/obsidian-skills", url: "https://github.com/kepano/obsidian-skills" },
  { match: (n) => n.startsWith("grill-") || n === "to-prd", repo: "mattpocock/skills", url: "https://github.com/mattpocock/skills" },
  { match: (n) => n.endsWith("-code-review"), repo: "obra/Superpowers", url: "https://github.com/obra/Superpowers" },
  { match: (n) => n === "humanizer-zh", repo: "op7418/Humanizer-zh", url: "https://github.com/op7418/Humanizer-zh" },
  { match: (n) => n === "prompt-optimizer", repo: "daymade/claude-code-skills", url: "https://github.com/daymade/claude-code-skills" },
  { match: (n) => n === "context7", repo: "netresearch/context7-skill", url: "https://github.com/netresearch/context7-skill" },
  { match: (n) => n === "xiaohongshu-note-analyzer" || n.startsWith("xhs-"), repo: "softbread/xiaohongshu-doctor", url: "https://github.com/softbread/xiaohongshu-doctor" },
  { match: (n) => n === "find-skills", repo: "vercel-labs/skills", url: "https://github.com/vercel-labs/skills" },
  { match: (n) => n.startsWith("lark-"), repo: "open.feishu.cn", url: "https://open.feishu.cn" },
];

function matchCuratedRule(name: string): SkillProvenance | null {
  for (const rule of CURATED_ECOSYSTEM_RULES) {
    if (rule.match(name)) {
      const isGh = rule.url.includes("github.com");
      return {
        kind: "meta",
        repo: rule.repo,
        identity: rule.url.toLowerCase(),
        url: isGh ? rule.url : null,
        category: null,
        path: null,
      };
    }
  }
  return null;
}

export interface ProvenanceInput {
  rootPath: string; skillPath: string; name: string; declaredName?: string; installSource?: InstallSource | null;
}
const unknown = (): SkillProvenance => ({ kind: "root", repo: null, identity: null, url: null, category: null, path: null });
export async function resolveProvenance(input: ProvenanceInput, lock: LockIndex | null): Promise<SkillProvenance> {
  if (input.installSource) {
    const installed = fromInstallSource(input.installSource);
    if (installed) return installed;
  }
  if (lock) {
    const entry = Object.hasOwn(lock.entries, input.name) ? lock.entries[input.name] : input.declaredName && Object.hasOwn(lock.entries, input.declaredName) ? lock.entries[input.declaredName] : undefined;
    const resolved = fromLockEntry(entry);
    if (resolved) return resolved;
  }
  const dir = dirname(input.skillPath);
  if (input.rootPath && dir === input.rootPath) {
    // 根目录下扁平技能：非测试技能时尝试生态规则
    if (basename(input.rootPath) === "skills" || input.rootPath.includes(".agents")) {
      const curated = matchCuratedRule(input.name);
      if (curated) return curated;
    }
    return unknown();
  }
  const fromMeta = await fromMarketMeta(dir);
  if (fromMeta) return fromMeta;

  if (basename(input.rootPath) === "skills" || input.rootPath.includes(".agents")) {
    const curated = matchCuratedRule(input.name);
    if (curated) return curated;
  }

  return unknown();
}

/**
 * 把当前 ~/.agents/skills (以及已加载 roots) 下已有的 skills 适配「来源仓库」分组。
 * 将高置信度映射持久化写入 ~/.dsh/skills-manager/provenance-mapping.json，稳定且低成本。
 * 不确定的 skills 划入「未知」分组。
 */
export async function adaptProvenance(roots?: RootView[]): Promise<{
  total: number;
  mapped: number;
  unknown: number;
  repos: string[];
}> {
  const mappingEntries: Record<string, unknown> = await readPersistentMapping();
  const foundRepos = new Set<string>();
  let total = 0;
  let mappedCount = 0;
  let unknownCount = 0;

  const allSkills: Array<{ name: string; path: string; rootPath: string; declaredName?: string }> = [];
  if (Array.isArray(roots)) {
    for (const r of roots) {
      for (const s of r.skills || []) {
        allSkills.push({ name: s.name, path: s.path, rootPath: r.path, declaredName: s.declaredName });
      }
    }
  }

  for (const s of allSkills) {
    total++;
    let prov = await resolveProvenance({ rootPath: s.rootPath, skillPath: s.path, name: s.name, declaredName: s.declaredName }, null);
    if (!prov.repo && prov.kind === "root") {
      const curated = matchCuratedRule(s.name);
      if (curated) prov = curated;
    }

    if (prov.repo) {
      mappedCount++;
      foundRepos.add(prov.repo);
      mappingEntries[s.name] = {
        source: prov.repo,
        sourceType: prov.url && prov.url.includes("github.com") ? "github" : "well-known",
        sourceUrl: prov.url,
        repo: prov.repo,
        url: prov.url,
      };
    } else {
      unknownCount++;
    }
  }

  try {
    await mkdir(dirname(PERSISTENT_MAPPING_PATH), { recursive: true });
    await writeFile(
      PERSISTENT_MAPPING_PATH,
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), mappings: mappingEntries }, null, 2),
      "utf8"
    );
    evict(PERSISTENT_MAPPING_PATH);
  } catch (err) {
    console.error("Failed to write persistent provenance mapping:", err);
  }

  return {
    total,
    mapped: mappedCount,
    unknown: unknownCount,
    repos: Array.from(foundRepos).sort(),
  };
}

export async function attachProvenance<T extends { roots: RootView[] }>(snapshot: T): Promise<T> {
  const lockByRoot = new Map<string, LockIndex | null>();
  for (const root of snapshot.roots) {
    let lock = lockByRoot.get(root.path);
    if (lock === undefined) { lock = await readLockIndex(root.path); lockByRoot.set(root.path, lock); }
    const skills = root.skills || [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, skills.length) }, async () => {
      while (next < skills.length) {
        const skill = skills[next++];
        try {
          if (skill.provenanceInherited && skill.provenance) continue;
          skill.provenance = await resolveProvenance({ rootPath: root.path, skillPath: skill.path, name: skill.name, declaredName: skill.declaredName, installSource: skill.installSource }, lock);
        } catch { skill.provenance = unknown(); }
      }
    }));
  }
  return snapshot;
}
