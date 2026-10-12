import { getLocale as nextGetLocale, getTranslations } from "next-intl/server";
import { translateLibText } from "./libText";
import { localeOf, type Locale } from "./locales";

// The resolved locale as one of the five, for server components and route handlers.
export async function getLocale(): Promise<Locale> {
  return localeOf(await nextGetLocale());
}

// The server side of useLibText: a sentence lib/ wrote, in the request's language when the table knows it.
export async function libTextServer(): Promise<(text: string) => string> {
  const t = await getTranslations("lib");
  return (text) => translateLibText(t as unknown as (key: string, values?: Record<string, string | number>) => string, text);
}

// I9: an API error for the person who made the request, in their language. Cached routes never use this.
export async function jsonError(message: string, status: number): Promise<Response> {
  let text = message;
  try {
    text = (await libTextServer())(message);
  } catch {
    // Outside a request scope the English sentence stands.
  }
  return new Response(JSON.stringify({ error: text }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
