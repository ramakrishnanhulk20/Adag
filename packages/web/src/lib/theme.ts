export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_COOKIE = "adag-theme";
export const THEME_STORAGE_KEY = "adag-theme";
export const THEME_CHOICES: readonly ThemeChoice[] = ["system", "light", "dark"];
export const THEME_SWITCH_MS = 600;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function parseThemeChoice(value: string | null | undefined): ThemeChoice {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

// With "system" the server cannot see the visitor's OS setting, so it renders dark and the head script corrects it before paint.
export function serverResolvedTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "light" ? "light" : "dark";
}

export function themeCookieString(choice: ThemeChoice): string {
  return `${THEME_COOKIE}=${choice}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

// Runs in <head> before first paint. Kept dependency free and wrapped in try/catch so a blocked storage API cannot break the page.
export const themeHeadScript = `(function(){try{
var d=document.documentElement,k=${JSON.stringify(THEME_COOKIE)},c=null;
var m=document.cookie.match(new RegExp('(?:^|; )'+k+'=([^;]*)'));
if(m)c=decodeURIComponent(m[1]);
if(!c){try{c=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}
if(c==='light'||c==='dark'||c==='system'){document.cookie=k+'='+c+'; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax'}}
if(c!=='light'&&c!=='dark')c='system';
var r=c==='system'?(window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):c;
d.setAttribute('data-theme',r);d.setAttribute('data-theme-choice',c);
}catch(e){}})();`;
