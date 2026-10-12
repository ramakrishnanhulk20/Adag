// English is the interchange format inside the app: lib/ (the money path, the alerts, the break suite) writes its
// sentences in English and never learns about locales (I3, I8). The screens translate those sentences here, by
// matching them against the English templates in the "lib" namespace of the catalog and formatting the same key in
// the active language. A sentence the table does not know is shown as it is, in English.
import en from "../../messages/en.json";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Entry = { key: string; re: RegExp; params: string[]; literal: number };

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(key: string, template: string): Entry {
  const params: string[] = [];
  let source = "";
  let literal = 0;
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    const text = template.slice(last, m.index);
    source += escape(text);
    literal += text.length;
    params.push(m[1]!);
    // Zero or more: a template's optional clause (", or, in 2 rows, allowed by design") may be empty.
    source += "([\\s\\S]*?)";
    last = m.index! + m[0].length;
  }
  const tail = template.slice(last);
  source += escape(tail);
  literal += tail.length;
  return { key, re: new RegExp(`^${source}$`), params, literal };
}

type Tree = { [key: string]: string | Tree };
let table: Entry[] | null = null;

// Flattened from the English "lib" namespace, most literal text first, so the most specific template wins a tie.
function entries(): Entry[] {
  if (table) return table;
  const out: Entry[] = [];
  const walk = (node: Tree, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (typeof v === "string") out.push(compile(full, v));
      else walk(v, full);
    }
  };
  walk((en as unknown as { lib: Tree }).lib, "");
  table = out.sort((a, b) => b.literal - a.literal);
  return table;
}

const hasLetters = (s: string) => /[A-Za-z]{2}/.test(s);

function whole(t: Translate, text: string, depth: number): string | null {
  for (const e of entries()) {
    const m = e.re.exec(text);
    if (!m) continue;
    const values: Record<string, string> = {};
    e.params.forEach((p, i) => {
      const raw = m[i + 1]!;
      // A captured value such as "Bill #3" or "Simulated bill #12" may itself be a known English phrase.
      values[p] = depth < 2 && hasLetters(raw) ? translateLibText(t, raw, depth + 1) : raw;
    });
    return t(e.key, values);
  }
  return null;
}

// Sentence boundaries: a full stop, question or exclamation mark, then a space, then a capital, digit or quote.
const SENTENCE = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

export function translateLibText(t: Translate, text: string, depth = 0): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const direct = whole(t, trimmed, depth);
  if (direct !== null) return direct;
  if (depth >= 2) return text;
  const parts = trimmed.split(SENTENCE);
  if (parts.length < 2) return text;
  let changed = false;
  const out = parts.map((part) => {
    const hit = whole(t, part, depth + 1);
    if (hit !== null) changed = true;
    return hit ?? part;
  });
  return changed ? out.join(t("joiner") === "none" ? "" : " ") : text;
}
