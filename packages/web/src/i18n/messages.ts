import en from "../../messages/en.json";
import { DEFAULT_LOCALE, type Locale } from "./locales";

export type Messages = typeof en;
type Tree = { [key: string]: string | Tree };

// The English catalog is the floor: a key the other catalog lacks keeps its English string (I7).
function merge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const under = base[key];
    out[key] = typeof value === "object" && value !== null && typeof under === "object" && under !== null ? merge(under, value) : value;
  }
  return out;
}

const loaders: Record<Exclude<Locale, "en">, () => Promise<{ default: Tree }>> = {
  "zh-CN": () => import("../../messages/zh-CN.json"),
  ko: () => import("../../messages/ko.json"),
  ja: () => import("../../messages/ja.json"),
  es: () => import("../../messages/es.json"),
};

// The active locale's catalog with English underneath. A catalog that fails to load leaves English alone (I7).
export async function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === DEFAULT_LOCALE) return en;
  try {
    const loaded = (await loaders[locale as Exclude<Locale, "en">]()).default;
    return merge(en as unknown as Tree, loaded) as unknown as Messages;
  } catch {
    return en;
  }
}

let flatEnglish: Map<string, string> | null = null;

// "basket.title" style lookups into the English catalog, for the message fallback.
export function englishString(path: string): string | undefined {
  if (!flatEnglish) {
    flatEnglish = new Map();
    const walk = (node: Tree, prefix: string) => {
      for (const [key, value] of Object.entries(node)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "string") flatEnglish!.set(full, value);
        else walk(value, full);
      }
    };
    walk(en as unknown as Tree, "");
  }
  return flatEnglish.get(path);
}
