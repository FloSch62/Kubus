const SAFE_SHELL_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

function posixShellArgument(value: string): string {
  if (SAFE_SHELL_ARGUMENT.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function windowsShellArgument(value: string): string {
  if (SAFE_SHELL_ARGUMENT.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

export interface KubectlGetTarget {
  ctx: string;
  group: string;
  plural: string;
  name: string;
  namespace?: string;
}

export interface KubectlCommandOptions {
  /** Effective non-default kubeconfig files, in kubectl merge order. */
  kubeconfigPaths?: string[];
  shell?: 'posix' | 'windows';
}

/** Build a paste-ready command that preserves Kubus' exact cluster and resource scope. */
export function kubectlGetCommand(target: KubectlGetTarget, options: KubectlCommandOptions = {}): string {
  const shellArgument = options.shell === 'windows' ? windowsShellArgument : posixShellArgument;
  const resourceType = target.group ? `${target.plural}.${target.group}` : target.plural;
  const resource = shellArgument(`${resourceType}/${target.name}`);
  const namespace = target.namespace ? ` --namespace ${shellArgument(target.namespace)}` : '';
  const paths = options.kubeconfigPaths ?? [];
  const kubeconfig = paths.length === 1 ? ` --kubeconfig ${shellArgument(paths[0]!)}` : '';
  const prefix =
    paths.length > 1
      ? options.shell === 'windows'
        ? `set "KUBECONFIG=${paths.join(';')}" && `
        : `KUBECONFIG=${posixShellArgument(paths.join(':'))} `
      : '';
  return `${prefix}kubectl get ${resource}${namespace} --context ${shellArgument(target.ctx)}${kubeconfig}`;
}
