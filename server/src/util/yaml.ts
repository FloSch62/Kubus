import { CORE_SCHEMA, dump as yamlDump, load as yamlLoad, loadAll as yamlLoadAll, mergeTag } from 'js-yaml';

const LOAD_SCHEMA = CORE_SCHEMA.withTags(mergeTag);

export function loadYaml(source: string): unknown {
  return source.trim() ? yamlLoad(source, { schema: LOAD_SCHEMA }) : undefined;
}

export function loadAllYaml(source: string): unknown[] {
  return source.trim() ? yamlLoadAll(source, { schema: LOAD_SCHEMA }) : [];
}

export function dumpYaml(value: unknown, options?: Parameters<typeof yamlDump>[1]): string {
  return yamlDump(value, options);
}
