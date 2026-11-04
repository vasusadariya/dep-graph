/**
 * Tool dependency-graph generator.
 *
 *   node --import tsx src/generate.ts path/to/catalog.json
 *
 * Reads a toolkit catalog (Composio tool schemas) and writes `dependency_graph.json`
 * (+ `dependency_graph.html`). An edge `A -> B` labelled `p` means: tool B needs the
 * identifier `p` as a required input and tool A can produce it.
 *
 * Pipeline (nothing toolkit-specific is hardcoded):
 *   1. index   - resolve each tool's output schema and extract the entities it returns
 *                (collections like `pull_requests[]` or the single object a GET returns)
 *   2. match   - map every required identifier input (`pull_number`, `team_slug`, ...) to the
 *                entities that carry it (`PullRequest.number`, `Team.slug`, ...)
 *   3. rank    - prefer list/search producers that share the consumer's scope (owner/repo) and
 *                need few extra prerequisites; keep the best 1-2 per (consumer, input)
 *   4. refine  - optional LLM adjudication of near-tied candidates (cached; skipped offline)
 *   5. emit    - graph JSON + self-contained HTML visualization
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { renderHtml } from "./viz.js";

type Tool = Record<string, any>;
export interface Node {
  id: string;
  service?: string;
}
export interface Edge {
  from: string;
  to: string;
  label?: string;
}
export interface Graph {
  nodes: Node[];
  edges: Edge[];
}

const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = "dependency_graph.json";
const HTML_PATH = "dependency_graph.html";
const CACHE_PATH = ".cache/llm.json";
const MODEL = process.env.DEPGRAPH_MODEL ?? "openai/gpt-4o";

function loadCatalog(): Tool[] {
  if (!CATALOG_PATH) throw new Error("pass the toolkit catalog path as the first argument");
  const data = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
  return Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
}

const slugOf = (t: Tool): string | undefined => t.slug ?? t.name ?? t.function?.name;

/* ------------------------------------------------------------------ text helpers */

const STOP = new Set(["a", "an", "the", "of", "for", "in", "on", "by", "with", "to", "from", "at", "and", "or", "all"]);
const CUT = new Set(["for", "in", "of", "on", "by", "with", "to", "from", "at", "associated", "using", "via"]);
const LIST_V = new Set(["list", "search", "find", "query", "fetch"]);
const CREATE_V = new Set(["create", "add", "open", "fork", "generate", "start", "register", "upload", "post", "submit", "request", "new"]);
const GET_V = new Set(["get", "retrieve", "read", "show", "view", "describe", "check"]);
// Generic collection keys that carry no entity name -> fall back to the tool's slug noun.
const GENERIC_KEYS = new Set(["items", "data", "results", "result", "records", "list", "entries", "response", "values"]);
// Collections that never act as an id source.
const IGNORE_KEYS = new Set(["errors", "warnings", "labels", "topics", "assignees", "permissions", "reactions", "contexts"]);

function singular(w: string): string {
  if (w.length > 3 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}
function plural(w: string): string {
  if (w.endsWith("y") && !/[aeiou]y$/.test(w)) return w.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/.test(w)) return w + "es";
  return w + "s";
}
/** "pull_requests" | "PullRequest" | "pullRequests" -> ["pull","request"] (singular, lowercase) */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}
const rawWords = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/* ------------------------------------------------------------------ schema helpers */

function deref(schema: any, defs: Record<string, any>, depth = 0): any {
  let s = schema;
  while (s && s.$ref && depth++ < 8) s = defs?.[String(s.$ref).split("/").pop()!] ?? undefined;
  if (s?.anyOf || s?.oneOf) {
    const alt = (s.anyOf ?? s.oneOf).find((x: any) => x && x.type !== "null");
    if (alt) return deref(alt, defs, depth);
  }
  return s;
}

interface Entity {
  tokens: string[]; // singular lowercase words naming the entity (e.g. ["pull","request"])
  fields: Set<string>; // scalar field names available on one item
  isList: boolean;
}

interface ToolInfo {
  slug: string;
  tool: Tool;
  verbs: string; // list | search | get | create | other
  head: string[]; // resource noun phrase from the slug (singular tokens)
  entities: Entity[];
  required: string[]; // required input names
  idInputs: string[]; // required inputs that look like identifiers
  service: string;
  deprecated: boolean;
  desc: string;
}

function slugTokens(tool: Tool, slug: string): string[] {
  const prefix = String(tool.toolkit?.slug ?? slug.split("_")[0]).toLowerCase();
  const toks = slug.toLowerCase().split("_");
  return toks[0] === prefix ? toks.slice(1) : toks;
}

function describeSlug(tool: Tool, slug: string): { verb: string; head: string[] } {
  const toks = slugTokens(tool, slug);
  const v = toks[0] ?? "";
  const verb = LIST_V.has(v) ? (v === "search" || v === "find" || v === "query" ? "search" : "list") : GET_V.has(v) ? "get" : CREATE_V.has(v) ? "create" : "other";
  const rest: string[] = [];
  for (const w of toks.slice(1)) {
    if (CUT.has(w)) break;
    if (!STOP.has(w)) rest.push(singular(w));
  }
  // "GET_ALL_..." / "LIST_ALL_..." handled by STOP (all)
  return { verb, head: rest };
}

function itemFields(item: any, defs: Record<string, any>): Set<string> {
  const out = new Set<string>();
  const o = deref(item, defs);
  for (const [k, v] of Object.entries<any>(o?.properties ?? {})) {
    const d = deref(v, defs);
    const t = d?.type ?? v?.type;
    // scalar fields, plus nested objects (we record `owner` so `owner` inputs can match).
    if (t !== "array") out.add(k.toLowerCase());
    if (t === "object" || d?.properties) {
      for (const k2 of Object.keys(d?.properties ?? {})) out.add(`${k.toLowerCase()}.${k2.toLowerCase()}`);
    }
  }
  return out;
}

function extractEntities(tool: Tool, head: string[]): Entity[] {
  const out = tool.outputParameters;
  const defs = out?.$defs ?? {};
  const data = deref(out?.properties?.data, defs);
  if (!data) return [];
  const ents: Entity[] = [];
  let sawList = false;
  for (const [key, val] of Object.entries<any>(data.properties ?? {})) {
    const d = deref(val, defs);
    if ((d?.type ?? val?.type) !== "array" || IGNORE_KEYS.has(key.toLowerCase())) continue;
    const items = d?.items ?? val?.items;
    const it = deref(items, defs);
    if (!it?.properties) continue;
    sawList = true;
    const keyToks = GENERIC_KEYS.has(key.toLowerCase()) ? head : words(key);
    const defName = String(items?.$ref ?? "").split("/").pop() ?? "";
    const toks = [...new Set([...keyToks, ...(defName ? words(defName) : [])])];
    ents.push({ tokens: toks, fields: itemFields(items, defs), isList: true });
  }
  // A response that is itself an object (GET/CREATE) describes one entity named by the slug.
  if (!sawList && data.properties && Object.keys(data.properties).length) {
    ents.push({ tokens: head, fields: itemFields(data, defs), isList: false });
  }
  return ents;
}

/* ------------------------------------------------------------------ input classification */

// Inputs the caller supplies themselves (free text, flags, filters, payload) - never produced by another tool.
const USER_SUPPLIED = new Set([
  "body", "title", "message", "content", "description", "text", "state", "q", "query", "visibility", "labels", "value", "type",
  "path", "limit", "per_page", "page", "sort", "direction", "order", "url", "email", "password", "token", "access_token", "secret", "key",
  "encrypted_value", "permission", "role", "event", "events", "config", "language", "since", "until", "affiliation", "filter",
  "files", "data", "payload", "reason", "conclusion", "status", "context", "target", "client_secret", "client_mutation_id",
]);
// English aliases: bare input names that refer to an entity. Maps to [entity tokens, fields that satisfy it].
const ALIASES: Record<string, Array<{ tokens: string[]; fields: string[]; w: number }>> = {
  owner: [
    { tokens: ["repository"], fields: ["owner", "owner.login", "full_name"], w: 1 },
    { tokens: ["organization"], fields: ["login"], w: 0.6 },
    { tokens: ["user"], fields: ["login"], w: 0.6 },
  ],
  repo: [{ tokens: ["repository"], fields: ["name", "full_name"], w: 1 }],
  org: [{ tokens: ["organization"], fields: ["login", "name", "slug"], w: 1 }],
  username: [{ tokens: ["user"], fields: ["login"], w: 1 }],
  branch: [{ tokens: ["branch"], fields: ["name"], w: 1 }],
  ref: [{ tokens: ["branch"], fields: ["name"], w: 0.7 }, { tokens: ["tag"], fields: ["name"], w: 0.7 }],
  sha: [{ tokens: ["commit"], fields: ["sha"], w: 1 }],
};
const SUFFIX_FIELDS: Record<string, string[]> = {
  number: ["number"],
  id: ["id"],
  ids: ["id"],
  slug: ["slug"],
  name: ["name", "slug"],
  sha: ["sha"],
  key: ["key"],
};

interface Need {
  param: string;
  alts: Array<{ tokens: string[]; fields: string[]; w: number; exact: boolean }>;
}

/** Turn a required input name into the entities/fields that could satisfy it (or null = user supplied). */
function classifyInput(name: string, prop: any): Need | null {
  const n = name.toLowerCase();
  if (USER_SUPPLIED.has(n)) return null;
  if (prop?.enum || prop?.type === "boolean" || prop?.type === "array" || prop?.type === "object") return null;
  if (ALIASES[n]) return { param: name, alts: ALIASES[n].map((a) => ({ ...a, exact: true })) };
  const m = n.match(/^(.*?)_?(number|id|ids|slug|name|sha|key)$/);
  if (!m || !m[1]) return null;
  const stem = words(m[1]);
  if (!stem.length) return null;
  const alts = [{ tokens: stem, fields: SUFFIX_FIELDS[m[2]], w: 1, exact: true }];
  if (m[2] === "sha") alts[0].tokens = stem;
  return { param: name, alts };
}

/* ------------------------------------------------------------------ matching + ranking */

const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (full: string[], pre: string[]) => pre.every((x, i) => full[i] === x);
const endsWith = (full: string[], suf: string[]) => suf.length <= full.length && suf.every((x, i) => full[full.length - suf.length + i] === x);

function entityScore(e: Entity, alt: Need["alts"][number]): number {
  if (!alt.fields.some((f) => e.fields.has(f))) return 0;
  // exact naming ("issue" == issue) beats a leading/trailing partial ("pull" ~ pull request).
  if (eq(e.tokens, alt.tokens)) return 3;
  // single word contained in the entity's last word ("hook" ~ "webhook")
  if (alt.tokens.length === 1 && e.tokens.length && alt.tokens[0].length >= 4) {
    const last = e.tokens[e.tokens.length - 1];
    if (last.length > alt.tokens[0].length && last.endsWith(alt.tokens[0])) return 2.6;
  }
  if (e.tokens.length && (startsWith(e.tokens, alt.tokens) || endsWith(e.tokens, alt.tokens))) return 1.6;
  return 0;
}

interface Cand {
  producer: string;
  score: number;
  tier: number; // entity-match quality (3 exact, 2.6 fuzzy, 1.6 partial; scaled by alias weight)
  reason: string;
}

function buildGraph(infos: ToolInfo[]): { edges: Edge[]; ambiguous: Amb[] } {
  const bySlug = new Map(infos.map((i) => [i.slug, i]));
  const needsOf = new Map<string, Need[]>();
  const props = (i: ToolInfo) => i.tool.inputParameters?.properties ?? {};
  for (const i of infos) {
    const ns: Need[] = [];
    for (const r of i.required) {
      const n = classifyInput(r, props(i)[r]);
      if (n) ns.push(n);
    }
    needsOf.set(i.slug, ns);
    i.idInputs = ns.map((n) => n.param);
  }

  const chosen = new Map<string, { edge: Edge; score: number }>();
  const ambiguous: Amb[] = [];

  for (const consumer of infos) {
    const needs = needsOf.get(consumer.slug)!;
    const cTokens = new Set(slugTokens(consumer.tool, consumer.slug).map(singular));
    for (const need of needs) {
      const cands: Cand[] = [];
      for (const p of infos) {
        if (p === consumer || !["list", "search", "get", "create"].includes(p.verbs)) continue;
        if (p.required.includes(need.param)) continue; // cannot bootstrap the id it needs itself
        let best = 0;
        let bestEnt: Entity | undefined;
        for (const e of p.entities) {
          for (const alt of need.alts) {
            const s = entityScore(e, alt) * alt.w;
            if (s > best) {
              best = s;
              bestEnt = e;
            }
          }
        }
        if (!best || !bestEnt) continue;
        let score = best;
        // producer kind: collections are the natural source of ids
        score += p.verbs === "list" ? 1.2 : p.verbs === "search" ? 0.6 : p.verbs === "create" ? 0.3 : 0.4;
        // scope: shared required context (owner/repo/org) vs. prerequisites the consumer does not have
        const shared = p.idInputs.filter((x) => consumer.required.includes(x)).length;
        const extra = p.required.filter((x) => !consumer.required.includes(x)).length;
        score += 0.7 * shared - 0.7 * extra;
        // context words: consumer "UPDATE_AN_ISSUE_COMMENT" ~ producer entity "issue comment"
        const overlap = bestEnt.tokens.filter((t) => cTokens.has(t)).length;
        score += Math.min(overlap, 3) * 0.5;
        if (p.service === consumer.service) score += 0.4;
        if (p.deprecated) score -= 3;
        if (/mcpignore/i.test(JSON.stringify(p.tool.tags ?? []))) score -= 0.2;
        cands.push({ producer: p.slug, score, tier: best, reason: `${bestEnt.tokens.join(" ")}.${need.param}` });
      }
      if (!cands.length) continue;
      cands.sort((a, b) => b.score - a.score || a.producer.localeCompare(b.producer));
      const top = cands[0];
      const isScope = need.param === "owner" || need.param === "repo";
      // a partial entity match ("workflow" ~ workflow runs) is only used when nothing names the entity exactly
      const pool = cands.some((c) => c.tier >= 2.6) ? cands.filter((c) => c.tier >= 2.6) : cands;
      const keep = pool.filter((c, k) => k < (isScope ? 1 : 2) && c.score >= top.score - 1.2 && c.score > 1.5);
      for (const c of keep) {
        const key = `${c.producer}|${consumer.slug}|${need.param}`;
        chosen.set(key, { edge: { from: c.producer, to: consumer.slug, label: need.param }, score: c.score });
      }
      // near-tied top candidates -> worth a (cheap, cached) second opinion
      if (!isScope && cands.length > 1 && cands[0].score - cands[1].score < 0.8) {
        ambiguous.push({
          consumer: consumer.slug,
          param: need.param,
          desc: String(props(consumer)[need.param]?.description ?? "").slice(0, 200),
          cands: cands.slice(0, 5).map((c) => ({ slug: c.producer, desc: bySlug.get(c.producer)!.desc })),
        });
      }
    }
  }

  // break 2-cycles: keep the stronger direction
  for (const [k, v] of [...chosen]) {
    const rev = [...chosen.entries()].find(([, o]) => o.edge.from === v.edge.to && o.edge.to === v.edge.from);
    if (rev && chosen.has(k) && v.score <= rev[1].score) chosen.delete(k);
  }
  return { edges: [...chosen.values()].map((v) => v.edge), ambiguous };
}

/* ------------------------------------------------------------------ optional LLM refinement */

interface Amb {
  consumer: string;
  param: string;
  desc: string;
  cands: Array<{ slug: string; desc: string }>;
}

async function refineWithLlm(edges: Edge[], amb: Amb[]): Promise<Edge[]> {
  const baseURL = process.env.LITMUS_API_URL ? `${process.env.LITMUS_API_URL.replace(/\/$/, "")}/proxy/openai/v1` : undefined;
  const apiKey = process.env.LITMUS_ASSESSMENT_TOKEN;
  if (!baseURL || !apiKey || !amb.length || process.env.DEPGRAPH_NO_LLM) return edges;

  let cache: Record<string, string[]> = {};
  try {
    if (existsSync(CACHE_PATH)) cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {}
  const idOf = (a: Amb) => createHash("sha1").update(MODEL + JSON.stringify(a)).digest("hex").slice(0, 16);
  const todo = amb.filter((a) => !(idOf(a) in cache)).slice(0, 200);

  if (todo.length) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey, baseURL });
    const batches: Amb[][] = [];
    for (let i = 0; i < todo.length; i += 12) batches.push(todo.slice(i, i + 12));
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const items = batch.map((a) => ({ id: idOf(a), consumer: a.consumer, input: a.param, input_description: a.desc, candidates: a.cands }));
        try {
          const r = await client.chat.completions.create({
            model: MODEL,
            temperature: 0,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "You build API tool dependency graphs. For each item, the consumer tool needs the required input `input`. " +
                  "Pick which candidate tools (at most 2, best first) should be called BEFORE it to obtain a real value for that input " +
                  "(e.g. a list tool returning the same resource kind, in the same scope). Return [] if the input is something the user must supply " +
                  'or no candidate returns that resource. Reply JSON: {"results": {"<id>": ["SLUG", ...]}}. Only use candidate slugs.',
              },
              { role: "user", content: JSON.stringify(items) },
            ],
          });
          const res = JSON.parse(r.choices[0]?.message?.content ?? "{}").results ?? {};
          for (const a of batch) if (Array.isArray(res[idOf(a)])) cache[idOf(a)] = res[idOf(a)].filter((x: any) => typeof x === "string");
        } catch (e: any) {
          console.error(`llm batch skipped: ${e?.message ?? e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    try {
      mkdirSync(".cache", { recursive: true });
      writeFileSync(CACHE_PATH, JSON.stringify(cache));
    } catch {}
  }

  // Apply verdicts: among a group's candidates, keep the LLM's picks (only when it answered).
  const drop = new Set<string>();
  const add: Edge[] = [];
  for (const a of amb) {
    const verdict = cache[idOf(a)];
    if (!verdict) continue;
    const valid = verdict.filter((s) => a.cands.some((c) => c.slug === s));
    if (!valid.length) continue; // do not drop on empty answers: heuristics stay authoritative
    for (const c of a.cands) if (!valid.includes(c.slug)) drop.add(`${c.slug}|${a.consumer}|${a.param}`);
    for (const s of valid) add.push({ from: s, to: a.consumer, label: a.param });
  }
  const seen = new Set<string>();
  return [...edges.filter((e) => !drop.has(`${e.from}|${e.to}|${e.label}`)), ...add].filter((e) => {
    const k = `${e.from}|${e.to}|${e.label}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/* ------------------------------------------------------------------ assemble */

const HINT_TAG = /hint$|^mcpignore$|^important$|^deprecated$|graphql/i;

function serviceOf(tool: Tool, head: string[]): string {
  const tag = (tool.tags ?? []).find((t: string) => typeof t === "string" && !HINT_TAG.test(t) && t === t.toLowerCase() && /^[a-z][a-z0-9_-]*$/.test(t));
  if (tag) return tag;
  return head[0] ? plural(head[0]) : "misc";
}

function indexTools(tools: Tool[]): ToolInfo[] {
  const seen = new Set<string>();
  const out: ToolInfo[] = [];
  for (const tool of tools) {
    const slug = slugOf(tool);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const { verb, head } = describeSlug(tool, slug);
    const required: string[] = tool.inputParameters?.required ?? tool.parameters?.required ?? [];
    out.push({
      slug,
      tool,
      verbs: verb,
      head,
      entities: extractEntities(tool, head),
      required,
      idInputs: [],
      service: serviceOf(tool, head),
      deprecated: !!tool.isDeprecated || (tool.tags ?? []).includes("deprecated"),
      desc: String(tool.description ?? "").slice(0, 160),
    });
  }
  return out;
}

export async function generate(tools: Tool[]): Promise<Graph> {
  const infos = indexTools(tools);
  const { edges, ambiguous } = buildGraph(infos);
  const refined = await refineWithLlm(edges, ambiguous);
  const ids = new Set(infos.map((i) => i.slug));
  const final = refined
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
    .sort((a, b) => a.to.localeCompare(b.to) || a.label!.localeCompare(b.label!) || a.from.localeCompare(b.from));
  return { nodes: infos.map((i) => ({ id: i.slug, service: i.service })), edges: final };
}

async function main() {
  const graph = await generate(loadCatalog());
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  writeFileSync(HTML_PATH, renderHtml(graph), "utf-8");
  console.error(`wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH} (+ ${HTML_PATH})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
