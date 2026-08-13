const SAFE_SHELL_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellArgument(value: string): string {
  if (SAFE_SHELL_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface KubectlGetTarget {
  ctx: string;
  group: string;
  plural: string;
  name: string;
  namespace?: string;
}

/** Build a paste-ready command that preserves Kubus' exact cluster and resource scope. */
export function kubectlGetCommand(target: KubectlGetTarget): string {
  const resourceType = target.group ? `${target.plural}.${target.group}` : target.plural;
  const resource = shellArgument(`${resourceType}/${target.name}`);
  const namespace = target.namespace ? ` --namespace ${shellArgument(target.namespace)}` : '';
  return `kubectl get ${resource}${namespace} --context ${shellArgument(target.ctx)}`;
}
