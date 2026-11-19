import type { InkChild, InkNode } from './ink.js';

export function jsx<Props>(
  component: (props: Props) => InkNode,
  props: Props,
): InkNode {
  return component(props);
}

export const jsxs = jsx;

export function Fragment(props: { children?: InkChild }): InkNode {
  return { kind: 'fragment', children: props.children };
}

export namespace JSX {
  export type Element = InkNode;
  export interface IntrinsicAttributes {
    key?: string | number;
  }
  export interface ElementChildrenAttribute {
    children: unknown;
  }
}
