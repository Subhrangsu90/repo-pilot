import { catalogDocument, propUpdate, propsUpdate, readSurface, REPOPILOT_CATALOG_ID, rootComponent, surfaceMessages, toNode } from './a2ui';
import { componentNames, validateNode } from './catalog';

const report = {
  component: 'Section',
  props: {
    title: 'Health',
    children: [
      { component: 'StatCard', props: { label: 'Open PRs', value: 3 } },
      { component: 'IssueTable', props: { rows: [{ number: 7, title: 'Crash', state: 'open', ageDays: 4 }] } },
    ],
  },
};

describe('surfaceMessages', () => {
  it('creates the surface, a flat component list with bindings, then the data model', () => {
    const [create, components, data] = surfaceMessages('s1', report);
    expect(create).toEqual({ version: '1.0', createSurface: { surfaceId: 's1', catalogId: REPOPILOT_CATALOG_ID } });
    expect(components).toEqual({
      version: '1.0',
      updateComponents: {
        surfaceId: 's1',
        components: [
          { id: 'root', component: 'Section', title: { '@path': '/root/title' }, children: ['root_0', 'root_1'] },
          {
            id: 'root_0',
            component: 'StatCard',
            label: { '@path': '/root_0/label' },
            value: { '@path': '/root_0/value' },
            tone: { '@path': '/root_0/tone' },
          },
          {
            id: 'root_1',
            component: 'IssueTable',
            rows: { '@path': '/root_1/rows' },
            selectable: { '@path': '/root_1/selectable' },
            emptyText: { '@path': '/root_1/emptyText' },
          },
        ],
      },
    });
    // Validated props with schema defaults applied; children are not data.
    const model = (data as { updateDataModel: { value: Record<string, Record<string, unknown>> } }).updateDataModel.value;
    expect(model['root']).toEqual({ title: 'Health' });
    expect(model['root_0']).toEqual({ label: 'Open PRs', value: 3, tone: 'neutral' });
    expect(model['root_1']['rows']).toEqual([{ number: 7, title: 'Crash', state: 'open', ageDays: 4, labels: [], assignees: [] }]);
  });

  it('puts an ErrorFallback in the slot of an invalid child and keeps its siblings', () => {
    const view = readSurface(
      surfaceMessages('s1', { component: 'Grid', props: { children: [{ component: 'Nope', props: {} }, { component: 'StatCard', props: { label: 'x', value: 1 } }] } }),
    );
    expect(view.components.map((c) => c.component)).toEqual(['Grid', 'ErrorFallback', 'StatCard']);
    expect(String((view.data['root_0'] as { message: string }).message)).toContain('Unknown component "Nope"');
  });

  it('turns a whole invalid tree into one ErrorFallback, with the raw payload as text', () => {
    const view = readSurface(surfaceMessages('s1', { component: 'StatCard', props: { label: '<img src=x onerror=alert(1)>' } }));
    expect(rootComponent(view)).toBe('ErrorFallback');
    expect((view.data['root'] as { raw: string }).raw).toContain('<img src=x');
  });

  it('caps the number of components', () => {
    const many = { component: 'Grid', props: { children: Array.from({ length: 24 }, () => ({ component: 'Grid', props: { children: Array.from({ length: 24 }, () => ({ component: 'StatCard', props: { label: 'x', value: 1 } })) } })) } };
    const view = readSurface(surfaceMessages('s1', many));
    expect(view.components.length).toBeLessThanOrEqual(201);
    expect(view.components.some((c) => c.component === 'ErrorFallback')).toBe(true);
  });
});

describe('readSurface / toNode', () => {
  it('folds data updates in order and rebuilds a valid node tree', () => {
    const messages = [...surfaceMessages('s1', report), propUpdate('s1', 'root_0', 'value', 9)];
    const view = readSurface(messages);
    const node = toNode(view)!;
    expect(validateNode(node).ok).toBe(true);
    expect((node.props as { children: { props: { value: number } }[] }).children[0].props.value).toBe(9);
  });

  it('replaces a component\'s props and ignores children in the update', () => {
    const view = readSurface([...surfaceMessages('s1', report), propsUpdate('s1', 'root', { title: 'New', children: [] })]);
    expect(view.data['root']).toEqual({ title: 'New' });
    expect(view.components.find((c) => c.id === 'root')?.['children']).toEqual(['root_0', 'root_1']);
  });

  it('removes a key set to null, as the protocol says', () => {
    const view = readSurface([...surfaceMessages('s1', report), propUpdate('s1', 'root', 'title', null)]);
    expect(view.data['root']).toEqual({});
  });
});

describe('catalogDocument', () => {
  it('describes every catalog component for protocol 1.0', () => {
    const doc = catalogDocument() as { protocolVersion: string; catalogId: string; components: Record<string, { properties: Record<string, unknown>; required: string[] }> };
    expect(doc.protocolVersion).toBe('1.0');
    expect(doc.catalogId).toBe(REPOPILOT_CATALOG_ID);
    expect(Object.keys(doc.components).sort()).toEqual([...componentNames].sort());
    expect(doc.components['Grid'].properties['children']).toMatchObject({ $ref: 'common_types.json#/$defs/ChildList' });
    // Data props accept a literal or a data binding.
    expect(doc.components['StatCard'].properties['label']).toMatchObject({ anyOf: [{ type: 'string' }, { $ref: 'common_types.json#/$defs/DataBinding' }] });
    expect(doc.components['StatCard'].required).toEqual(['component', 'label', 'value']);
  });
});
