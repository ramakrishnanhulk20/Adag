import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Every word a visitor reads comes from the catalog. This walks the JSX under src/components and src/app (the lab and
// the English-only docs excepted) and fails on English left in JSX text or in aria-label, title, placeholder and alt.
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCAN = ['components', 'app'];
const SKIP_DIRS = new Set(['lab', 'docs']);
const ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt']);

// Brand names, tickers, symbols and code identifiers are not English prose and stay the same in every language.
const ALLOW = new Set([
  'ADAG',
  'Adag',
  'AdagBills',
  'AdagGuard',
  // next/image's placeholder prop names a loading style, not text a visitor reads.
  'blur',
  'empty',
  'USDC',
  'EURC',
  'cirBTC',
  'Morpho',
  'Sourcify',
  'tx',
  'Multicall3From.aggregate3(calls)',
  'Adag {capPct}%',
  'Morpho {lltvPct}%',
  'allowFailure false',
  'bills.pay',
  'memo.pay',
  'approve',
  'supply',
  'borrow',
  'UTC',
]);
// Fragments with no letters at all, or only a symbol, a number, a ticker or an address, are fine wherever they sit.
const NO_PROSE = /^[^A-Za-z]*$|^0x[0-9a-fA-F…]+$|^(cirBTC|USDC|EURC|BTC|USD|EUR|WETH)$/;

const files = [];
const collect = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(p);
    } else if (/\.tsx$/.test(name)) files.push(p);
  }
};
for (const dir of SCAN) collect(join(ROOT, 'src', dir));

const isProse = (text) => {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed || NO_PROSE.test(trimmed) || ALLOW.has(trimmed)) return false;
  // Two or more consecutive letters, so "·", "%", "#" and single-letter legends pass.
  return /[A-Za-z]{2,}/.test(trimmed);
};

function findings(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out = [];
  const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node, kind, text) => out.push(`${relative(ROOT, file)}:${line(node)} ${kind} ${JSON.stringify(text.replace(/\s+/g, ' ').trim())}`);
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      if (isProse(node.text)) report(node, 'text', node.text);
    } else if (ts.isJsxExpression(node) && node.expression) {
      const e = node.expression;
      if (ts.isStringLiteral(e) && isProse(e.text)) report(node, 'expression', e.text);
      if (ts.isNoSubstitutionTemplateLiteral(e) && isProse(e.text)) report(node, 'expression', e.text);
      if (ts.isTemplateExpression(e)) {
        const literal = [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' ');
        if (isProse(literal) && ts.isJsxElement(node.parent)) report(node, 'template', literal);
      }
    } else if (ts.isJsxAttribute(node) && ATTRIBUTES.has(node.name.getText(source)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init) && isProse(init.text)) report(node, node.name.getText(source), init.text);
      if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        if ((ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && isProse(e.text)) report(node, node.name.getText(source), e.text);
        if (ts.isTemplateExpression(e)) {
          const literal = [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' ');
          if (isProse(literal)) report(node, node.name.getText(source), literal);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

test('no English prose is left in JSX text, aria-label, title, placeholder or alt outside the lab and the docs', () => {
  assert.ok(files.length > 50, `expected the component tree, found ${files.length} files`);
  const all = files.flatMap(findings);
  assert.deepEqual(all, [], `hardcoded English:\n${all.join('\n')}`);
});
