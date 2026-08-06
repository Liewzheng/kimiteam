// apps/kimi-web/test/markdown-rendering.test.ts
// Capability tests for the Markdown pipeline that now renders subagent-facing
// messages (TeamMessage-style injected content): the parser used here is the
// exact one markstream-vue / Markdown.vue renders with, exercised headlessly.
// Bold / lists / tables / fenced code are the cases the user reported as
// showing raw in the subagent detail panel.

import { describe, expect, it } from 'vitest';
import { getMarkdown, parseMarkdownToStructure, type ParsedNode } from 'markstream-vue';

function parseNodes(md: string): ParsedNode[] {
  return parseMarkdownToStructure(md, getMarkdown(), { final: true });
}

function findNode(nodes: ParsedNode[], predicate: (n: ParsedNode) => boolean): ParsedNode | null {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const children = (node as { children?: ParsedNode[] }).children;
    const found = children ? findNode(children, predicate) : null;
    if (found) return found;
  }
  return null;
}

function textOf(nodes: ParsedNode[]): string {
  return nodes.map((n) => (n.type === 'text' ? (n as { content: string }).content : '')).join('');
}

describe('Markdown capability (renderer behind injected messages)', () => {
  it('renders bold (**…**) as a strong node', () => {
    const nodes = parseNodes('请先 **审查配置** 再继续。');
    const strong = findNode(nodes, (n) => n.type === 'strong');
    expect(strong).not.toBeNull();
    const strongText = textOf((strong as { children?: ParsedNode[] }).children ?? []);
    expect(strongText).toContain('审查配置');
  });

  it('renders a GFM table as a table node with header + rows', () => {
    const nodes = parseNodes(
      ['| 成员 | 状态 |', '| --- | --- |', '| builder | working |', '| reviewer | resting |'].join(
        '\n',
      ),
    );
    const table = findNode(nodes, (n) => n.type === 'table');
    expect(table).not.toBeNull();
    expect((table as { header: { cells: unknown[] } }).header.cells).toHaveLength(2);
    expect((table as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it('renders a fenced code block with its language and body preserved', () => {
    const nodes = parseNodes('```ts\nconst x = 1;\n```');
    const code = findNode(nodes, (n) => n.type === 'code_block');
    expect(code).not.toBeNull();
    expect((code as { language: string }).language).toBe('ts');
    expect((code as { code: string }).code.trim()).toBe('const x = 1;');
  });

  it('renders bullet lists for TeamMessage-style prose', () => {
    const nodes = parseNodes('- 检查 CI\n- 合并 PR\n- 更新 CHANGELOG');
    expect(findNode(nodes, (n) => n.type === 'list')).not.toBeNull();
    const list = findNode(nodes, (n) => n.type === 'list') as { items: unknown[] };
    expect(list.items).toHaveLength(3);
  });
});
