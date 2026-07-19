/**
 * Minimal WebAssembly globals for the helm engine. Node provides these at
 * runtime; the type lib does not ship them outside "DOM", which a server
 * build should not pull in wholesale.
 */
declare namespace WebAssembly {
  class Module {
    private constructor();
  }
  class Instance {
    readonly exports: Record<string, unknown>;
    private constructor();
  }
  type ImportValue = ((...args: unknown[]) => unknown) | number | bigint | object;
  type Imports = Record<string, Record<string, ImportValue>>;
  function compile(bytes: ArrayBufferView | ArrayBuffer): Promise<Module>;
  function instantiate(module: Module, importObject?: Imports): Promise<Instance>;
}
