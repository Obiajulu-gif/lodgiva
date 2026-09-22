import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ReactNode } from 'react';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { Status } from '@/components/status';

/**
 * Plain-English callouts.
 *
 * Fumadocs' own `type` values (info/warn/error) read like log levels. Hotel
 * staff read these pages, so the MDX author writes <Note>, <Tip>, <Warning>
 * or <Danger> and gets a sensible default title.
 */
function Note({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <Callout type="info" title={title ?? 'Note'}>
      {children}
    </Callout>
  );
}

function Tip({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <Callout type="success" title={title ?? 'Tip'}>
      {children}
    </Callout>
  );
}

function Warning({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <Callout type="warn" title={title ?? 'Warning'}>
      {children}
    </Callout>
  );
}

/** For anything that can lose money, lose data, or expose guest information. */
function Danger({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <Callout type="error" title={title ?? 'Danger'}>
      {children}
    </Callout>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    Callout,
    Note,
    Tip,
    Warning,
    Danger,
    Status,
    Card,
    Cards,
    Step,
    Steps,
    Tab,
    Tabs,
    Accordion,
    Accordions,
    File,
    Files,
    Folder,
    TypeTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
