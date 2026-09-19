import { z } from 'zod';

const segment = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((s) => s !== '.' && s !== '..');
export const pluginManifestSchema = z
  .object({
    apiVersion: z.literal(1),
    id: z
      .string()
      .min(2)
      .max(64)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    name: z.string().min(1).max(60),
    version: z
      .string()
      .max(32)
      .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
    description: z.string().min(1).max(500),
    author: z.string().min(1).max(100),
    entry: z.literal('index.html'),
    permissions: z
      .object({
        resources: z.array(z.object({ group: segment.or(z.literal('')), resources: z.array(segment).min(1).max(50) }).strict()).max(30),
        actions: z.array(z.enum(['resource.open', 'pod.logs', 'pod.terminal', 'pod.interfaces', 'helm.open'])).max(5),
      })
      .strict(),
  })
  .strict();

export const pluginResourceSchema = z
  .object({
    ctx: z.string().min(1).max(1024),
    group: segment.or(z.literal('')),
    version: segment,
    plural: segment,
    namespace: segment.optional(),
    name: segment.optional(),
    labelSelector: z.string().max(2048).optional(),
    continue: z.string().max(8192).optional(),
    namespaceScope: z.array(segment).max(500).optional(),
  })
  .strict();

export const pluginInterfacesSchema = pluginResourceSchema.extend({
  group: z.literal(''),
  version: z.literal('v1'),
  plural: z.literal('pods'),
  name: segment,
  namespace: segment,
  container: segment,
});
