import type { RequestContext } from './context.js';
import { UnfoldError } from './errors.js';

export const inkContentType = 'text/ink';
export const inkMimeType = `${inkContentType}; charset=utf-8`;

export interface InkPageContext<Input> extends RequestContext {
  input: Input;
  prompt?: string;
}

export type InkPageClass<Input = never> = new () => {
  render(
    context: InkPageContext<Input>,
  ): AsyncGenerator<InkChild | InkPatch, void, unknown>;
};

interface PageOptions<Input> {
  input?: (value: unknown) => Input;
}

const pageOptions = new WeakMap<InkPageClass, PageOptions<unknown>>();

export function InkPage<Input = never>(options: PageOptions<Input> = {}) {
  return (page: InkPageClass<Input>) => {
    pageOptions.set(page, options);
  };
}

export function getPageOptions(Page: InkPageClass): PageOptions<unknown> {
  const options = pageOptions.get(Page);
  if (!options) throw new TypeError(`${Page.name} must use @InkPage()`);
  return options;
}

export type InkChild =
  InkNode | string | number | boolean | null | undefined | readonly InkChild[];

export type InkNode =
  | {
      kind: 'element';
      tag: 'view' | 'text' | 'button';
      props: ContentProps & { onTap?: InkAction };
    }
  | { kind: 'fragment'; children: InkChild }
  | { kind: 'region'; region: RegionDefinition; children: InkChild };

interface ContentProps {
  children?: InkChild;
  className?: string;
  style?: string;
}

export function View(props: ContentProps): InkNode {
  return { kind: 'element', tag: 'view', props };
}

export function Text(props: ContentProps): InkNode {
  return { kind: 'element', tag: 'text', props };
}

export function Button(props: ContentProps & { onTap?: InkAction }): InkNode {
  return { kind: 'element', tag: 'button', props };
}

interface InkAction {
  type: 'action';
  name: string;
  data: Readonly<Record<string, unknown>>;
}

export function action(
  name: string,
  data: Record<string, unknown> = {},
): InkAction {
  return { type: 'action', name, data };
}

type RegionMode = 'append' | 'replace';

interface RegionDefinition {
  name: string;
  mode: RegionMode;
  render(data: unknown): InkChild;
}

const patchTag: unique symbol = Symbol('ink patch');

export interface InkPatch {
  readonly [patchTag]: RegionDefinition;
  readonly data: unknown;
}

type RegionComponent<Value, Mode extends RegionMode> = ((props: {
  children?: InkChild;
}) => InkNode) &
  Record<Mode, (value: Value) => InkPatch>;

export function defineInkRegion<Value>(
  name: string,
  options: { mode: 'append'; component: (props: { value: Value }) => InkChild },
): RegionComponent<Value, 'append'>;
export function defineInkRegion<Value>(
  name: string,
  options: {
    mode: 'replace';
    component: (props: { value: Value }) => InkChild;
  },
): RegionComponent<Value, 'replace'>;
export function defineInkRegion<Value>(
  name: string,
  options: {
    mode: RegionMode;
    component: (props: { value: Value }) => InkChild;
  },
) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
    throw new TypeError(`Invalid Ink region name: ${name}`);
  }
  const region: RegionDefinition = {
    name,
    mode: options.mode,
    render: (value) => options.component({ value: value as Value }),
  };
  function regionComponent(props: { children?: InkChild }): InkNode {
    return { kind: 'region', region, children: props.children };
  }
  const patch = (data: Value) => ({ [patchTag]: region, data });
  return options.mode === 'append'
    ? Object.assign(regionComponent, { append: patch })
    : Object.assign(regionComponent, { replace: patch });
}

interface DocumentContext {
  regions?: Map<string, RegionDefinition>;
  actions?: InkAction[];
}

function escapeMarkup(value: string): string {
  if (/[{}]/.test(value)) {
    // Ink decodes entities before parsing WXML bindings.
    throw new UnfoldError(
      422,
      'unsupported_ink_text',
      'Ink template braces are reserved',
    );
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function markRegion(region: RegionDefinition, children: string): string {
  return region.mode === 'append'
    ? `${children}<?marker name="${region.name}">`
    : `<?start name="${region.name}">${children}<?end>`;
}

function serialize(
  child: InkChild,
  context: DocumentContext,
  parent?: string,
): string {
  if (child == null || typeof child === 'boolean') return '';
  if (typeof child === 'string' || typeof child === 'number')
    return escapeMarkup(String(child));
  if (Array.isArray(child))
    return child.map((value) => serialize(value, context, parent)).join('');
  const node = child as InkNode;
  if (node.kind === 'fragment')
    return serialize(node.children, context, parent);
  if (node.kind === 'region') {
    const { region } = node;
    if (
      !context.regions ||
      parent !== 'view' ||
      context.regions.has(region.name)
    ) {
      throw new TypeError(
        `Ink region ${region.name} must be unique and inside a View`,
      );
    }
    context.regions.set(region.name, region);
    return markRegion(
      region,
      serialize(node.children, { actions: context.actions }, parent),
    );
  }
  if (node.kind !== 'element') throw new TypeError('Expected an Ink JSX node');

  const { tag, props } = node;
  const cls =
    props.className === undefined
      ? ''
      : ` class="${escapeMarkup(props.className)}"`;
  const style =
    props.style === undefined ? '' : ` style="${escapeMarkup(props.style)}"`;
  let onTap = '';
  if (props.onTap) {
    if (!context.actions)
      throw new TypeError('Ink updates cannot declare new actions');
    const index = context.actions.push(props.onTap) - 1;
    onTap = ` bindtap="unfoldAction${index}"`;
  }

  return `<${tag}${cls}${style}${onTap}>${serialize(props.children, context, tag)}</${tag}>`;
}

function isPatch(value: InkChild | InkPatch): value is InkPatch {
  return value !== null && typeof value === 'object' && patchTag in value;
}

export function compilePage(first: IteratorResult<InkChild | InkPatch>) {
  if (first.done || isPatch(first.value)) {
    throw new TypeError('An Ink page must yield its initial view first');
  }
  const regions = new Map<string, RegionDefinition>();
  const actions: InkAction[] = [];
  const page = `<page>${serialize(first.value, { regions, actions })}</page>`;
  const methods = actions.map((value, index) => {
    const payload = JSON.stringify(value).replaceAll('<', '\\u003c');
    return `unfoldAction${index}() { this.postMessage(JSON.parse(${JSON.stringify(payload)})); }`;
  });
  const script = methods.length
    ? `\n<script setup>\nexport default {\n${methods.join(',\n')}\n};\n</script>\n`
    : '';
  return { source: page + script, regions };
}

export function compilePatch(
  value: InkChild | InkPatch,
  regions: Map<string, RegionDefinition>,
) {
  if (!isPatch(value))
    throw new TypeError(
      'An Ink page must yield a region update after its initial view',
    );
  const region = value[patchTag];
  if (regions.get(region.name) !== region) {
    throw new TypeError(`Ink region ${region.name} is not in this page`);
  }
  const fragment = serialize(region.render(value.data), {});
  return `<template for="${region.name}">${markRegion(region, fragment)}</template>`;
}
