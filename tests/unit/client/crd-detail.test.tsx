import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KubeObject } from '@kubus/shared';
import {
  CrdDetail,
  CrdSchemaDetail,
  OpenApiSchemaDetail,
  crdVersions,
} from '../../../client/src/components/detail/CrdDetail';

vi.mock('../../../client/src/components/detail/GenericDetail.js', () => ({
  GenericDetail: ({ children }: { children: React.ReactNode }) => <div data-testid="generic-detail">{children}</div>,
}));

vi.mock('../../../client/src/components/detail/Section.js', () => ({
  Section: ({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) => (
    <section>
      <h2>{title}{count === undefined ? '' : ` (${count})`}</h2>
      {children}
    </section>
  ),
}));

function crd(spec: Record<string, unknown>): KubeObject {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: { name: 'widgets.example.io', uid: 'widgets.example.io' },
    spec,
  };
}

describe('CRD details', () => {
  it('normalizes current, legacy, invalid, and absent version definitions', () => {
    expect(crdVersions(undefined)).toEqual([]);
    expect(crdVersions(crd({ versions: [{ name: 'v1' }, { name: '' }, null, { name: 3 }] }))).toEqual([{ name: 'v1' }]);

    const legacy = crd({
      version: 'v1beta1',
      validation: { openAPIV3Schema: { type: 'object' } },
      subresources: { status: {} },
      additionalPrinterColumns: [{ name: 'Ready', type: 'string', jsonPath: '.status.ready' }],
    });
    expect(crdVersions(legacy)).toEqual([
      expect.objectContaining({ name: 'v1beta1', served: true, storage: true }),
    ]);
    expect(crdVersions(crd({}))).toEqual([]);
  });

  it('renders the definition summary while omitting absent values', () => {
    render(
      <CrdDetail
        ctx="dev"
        obj={crd({
          group: 'example.io',
          names: {
            kind: 'Widget',
            plural: 'widgets',
            singular: 'widget',
            shortNames: ['wdg'],
            categories: ['all'],
          },
          scope: 'Namespaced',
          versions: [
            { name: 'v1alpha1', served: false },
            { name: 'v1', served: true, storage: true },
          ],
        })}
      />,
    );

    expect(screen.getByTestId('generic-detail')).toHaveTextContent('example.io');
    expect(screen.getByText('Storage version').closest('tr')).toHaveTextContent('v1');
    expect(screen.getByText('Versions').closest('tr')).toHaveTextContent('v1alpha1, v1');
    expect(screen.getByText('Short names').closest('tr')).toHaveTextContent('wdg');
  });

  it('handles missing schemas, missing versions, flags, warnings, and printer columns', () => {
    const obj = crd({
      versions: [
        { name: 'empty', served: false },
        {
          name: 'v1',
          served: true,
          storage: true,
          deprecated: true,
          deprecationWarning: 'Move to v2',
          subresources: { status: {}, scale: { specReplicasPath: '.spec.replicas' } },
          schema: {
            openAPIV3Schema: {
              type: 'object',
              required: ['spec'],
              properties: { spec: { type: 'string', description: 'Desired state' } },
            },
          },
          additionalPrinterColumns: [
            { name: 'Ready', type: 'boolean', jsonPath: '.status.ready', description: 'Whether it is ready' },
            {},
          ],
        },
      ],
    });

    const missing = render(<CrdSchemaDetail obj={obj} versionName="missing" />);
    expect(screen.getByText(/Version missing is not defined/)).toBeInTheDocument();
    missing.unmount();

    const empty = render(<CrdSchemaDetail obj={obj} versionName="empty" />);
    expect(screen.getByText(/does not publish an OpenAPI v3 schema/)).toBeInTheDocument();
    expect(screen.queryByText('served')).not.toBeInTheDocument();
    empty.unmount();

    render(<CrdSchemaDetail obj={obj} versionName="v1" />);
    expect(screen.getByText('served')).toBeInTheDocument();
    expect(screen.getByText('storage')).toBeInTheDocument();
    expect(screen.getByText('status subresource')).toBeInTheDocument();
    expect(screen.getByText('scale subresource')).toBeInTheDocument();
    expect(screen.getByText('deprecated')).toBeInTheDocument();
    expect(screen.getByText('Move to v2')).toBeInTheDocument();
    expect(screen.getByText('Printer columns (2)')).toBeInTheDocument();
    expect(screen.getByText('Whether it is ready')).toBeInTheDocument();
  });

  it('expands referenced, composed, array, and map schemas and reports their metadata', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let depth = 13; depth >= 0; depth -= 1) {
      deep = { type: 'object', properties: { [`depth${depth}`]: deep } };
    }

    const document = {
      $ref: '#/definitions/Root',
      definitions: {
        Root: {
          type: 'object',
          required: ['spec', 'allOfField'],
          allOf: [
            {
              required: ['fromAllOf'],
              properties: { fromAllOf: { type: 'integer', format: 'int32' } },
            },
          ],
          properties: {
            spec: {
              type: 'object',
              title: 'Specification',
              nullable: true,
              'x-kubernetes-preserve-unknown-fields': true,
              properties: {
                enabled: { type: 'boolean', default: false },
                count: { type: 'number' },
              },
              required: ['enabled'],
            },
            list: {
              type: 'array',
              items: { type: 'object', properties: { name: { type: 'string' } } },
              'x-kubernetes-list-type': 'map',
            },
            labels: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                required: ['value'],
                properties: { value: { type: 'string' } },
              },
            },
            choice: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
            either: { anyOf: [{ type: 'boolean' }, { type: 'number' }] },
            combined: { allOf: [{ type: 'object' }, { properties: { nested: { type: 'string' } } }] },
            flexible: { 'x-kubernetes-int-or-string': true },
            timestamp: { type: ['string', 'null'], format: 'date-time' },
            values: { type: 'object', additionalProperties: { type: 'number' } },
            unknown: {},
            badRef: { $ref: '#/definitions/Missing' },
            deep,
            enumField: { type: 'string', enum: ['one', 2], default: 'one' },
          },
        },
      },
    };

    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected' } as Selection);
    render(<OpenApiSchemaDetail document={document} />);

    expect(screen.getByText('string | integer')).toBeInTheDocument();
    expect(screen.getByText('boolean | number')).toBeInTheDocument();
    expect(screen.getByText('int-or-string')).toBeInTheDocument();
    expect(screen.getByText('string | null')).toBeInTheDocument();
    expect(screen.getByText('map<number>')).toBeInTheDocument();
    expect(screen.getByText('enum: one, 2')).toBeInTheDocument();
    expect(screen.getByText('default: "one"')).toBeInTheDocument();
    expect(screen.getByText('list: map')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand spec'));
    expect(screen.queryByText('enabled')).not.toBeInTheDocument();
    selection.mockReturnValue({ toString: () => '' } as Selection);

    for (const label of ['spec', 'list', 'labels', 'combined']) {
      fireEvent.click(screen.getByLabelText(`Expand ${label}`));
    }
    expect(screen.getByText('enabled')).toBeInTheDocument();
    expect(screen.getByText('name')).toBeInTheDocument();
    expect(screen.getByText('<value>.value')).toBeInTheDocument();
    expect(screen.getByText('nested')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Expand deep'));
    for (let depth = 0; depth <= 10; depth += 1) {
      fireEvent.click(screen.getByLabelText(`Expand depth${depth}`));
    }
    expect(screen.getByText('More nested fields omitted.')).toBeInTheDocument();
    selection.mockRestore();
  });
});
