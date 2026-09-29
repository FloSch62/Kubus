import type { ComponentType } from 'react';
import type { KubeObject } from '@kubus/shared';
import { CertificateDetail } from '../CertificateDetail.js';
import { ArgoApplicationActions, ArgoApplicationDetail } from './ArgoApplicationDetail.js';
import { appHeaderStatus } from './argo-cd.js';
import { rolloutHeaderStatus } from './argo-rollouts.js';
import { ExternalSecretActions, ExternalSecretDetail, readyHeaderStatus } from './ExternalSecretDetail.js';
import { fluxHeaderStatus } from './flux.js';
import { FluxActions, HelmReleaseDetail, KustomizationDetail } from './FluxDetail.js';
import { GatewayClassDetail, gatewayClassHeaderStatus } from './GatewayClassDetail.js';
import { GatewayDetail, gatewayHeaderStatus } from './GatewayDetail.js';
import { RolloutActions, RolloutDetail } from './RolloutDetail.js';
import { RouteDetail, routeHeaderStatus } from './RouteDetail.js';

/** Props of a dedicated custom-resource overview: the object plus its backing CRD. */
export interface CustomKindViewProps {
  obj: KubeObject;
  ctx: string;
  crd: KubeObject;
  version: string;
}

/** Props of a custom resource's action buttons in the drawer's quick-action bar. */
export interface CustomKindActionProps {
  ctx: string;
  group: string;
  version: string;
  plural: string;
  obj: KubeObject;
}

export interface CustomKindEntry {
  /** Replaces the generic printer-column overview. */
  view?: ComponentType<CustomKindViewProps>;
  /** Buttons for the quick-action bar (Sync, Promote, Reconcile). */
  actions?: ComponentType<CustomKindActionProps>;
  /** One status word for the drawer header. */
  status?: (obj: KubeObject) => string | undefined;
}

const GATEWAY = 'gateway.networking.k8s.io';
const route: CustomKindEntry = { view: RouteDetail, status: routeHeaderStatus };
const fluxSource: CustomKindEntry = { actions: FluxActions, status: fluxHeaderStatus };

/**
 * Dedicated views for well-known custom resources, keyed by `group/Kind`.
 * Everything else gets the generic overview driven by the CRD's printer
 * columns; each entry here is one self-contained file.
 */
const KIND_VIEWS: Record<string, CustomKindEntry> = {
  'cert-manager.io/Certificate': { view: CertificateDetail },
  [`${GATEWAY}/HTTPRoute`]: route,
  [`${GATEWAY}/GRPCRoute`]: route,
  [`${GATEWAY}/TLSRoute`]: route,
  [`${GATEWAY}/TCPRoute`]: route,
  [`${GATEWAY}/UDPRoute`]: route,
  [`${GATEWAY}/Gateway`]: { view: GatewayDetail, status: gatewayHeaderStatus },
  [`${GATEWAY}/GatewayClass`]: { view: GatewayClassDetail, status: gatewayClassHeaderStatus },
  'argoproj.io/Rollout': { view: RolloutDetail, actions: RolloutActions, status: rolloutHeaderStatus },
  'argoproj.io/Application': { view: ArgoApplicationDetail, actions: ArgoApplicationActions, status: appHeaderStatus },
  'external-secrets.io/ExternalSecret': { view: ExternalSecretDetail, actions: ExternalSecretActions, status: readyHeaderStatus },
  'kustomize.toolkit.fluxcd.io/Kustomization': { view: KustomizationDetail, actions: FluxActions, status: fluxHeaderStatus },
  'helm.toolkit.fluxcd.io/HelmRelease': { view: HelmReleaseDetail, actions: FluxActions, status: fluxHeaderStatus },
};

/** The dedicated entry for an object's group and kind, if there is one. Every Flux kind at least gets its actions. */
export function customKindEntry(apiVersion: string | undefined, kind: string | undefined): CustomKindEntry | undefined {
  if (!apiVersion || !kind) return undefined;
  const slash = apiVersion.indexOf('/');
  const group = slash === -1 ? '' : apiVersion.slice(0, slash);
  return KIND_VIEWS[`${group}/${kind}`] ?? (group.endsWith('.toolkit.fluxcd.io') ? fluxSource : undefined);
}
