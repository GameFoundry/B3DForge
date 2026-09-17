import type { DeploySchema, DeploySchemaField } from '@banshee-forge/shared';

/** Row form of a schema, so the editor can hold a half-typed name without losing the field. */
export interface DeployParameterRow {
  name: string;
  field: DeploySchemaField;
}

export function schemaToRows(schema: DeploySchema | undefined): DeployParameterRow[] {
  return Object.entries(schema ?? {}).map(([name, field]) => ({ name, field: { ...field } }));
}

/** Rows back to a schema; rows without a usable variable name are dropped. */
export function rowsToSchema(rows: DeployParameterRow[]): DeploySchema {
  const schema: DeploySchema = {};
  for (const row of rows) {
    const name = row.name.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    const field: DeploySchemaField = { type: row.field.type };
    if (row.field.label?.trim()) field.label = row.field.label.trim();
    if (row.field.description?.trim()) field.description = row.field.description.trim();
    if (row.field.required && row.field.type !== 'boolean') field.required = true;
    if (row.field.type === 'select') field.options = (row.field.options ?? []).map(o => o.trim()).filter(Boolean);
    if (row.field.type === 'string' && row.field.pattern?.trim()) field.pattern = row.field.pattern.trim();
    if (row.field.type === 'boolean') field.default = Boolean(row.field.default);
    else if (row.field.default !== undefined && String(row.field.default).trim()) field.default = String(row.field.default).trim();
    schema[name] = field;
  }
  return schema;
}

interface DeployParametersEditorProps {
  rows: DeployParameterRow[];
  onChange: (rows: DeployParameterRow[]) => void;
}

const INPUT = 'w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-gray-100 text-sm placeholder-gray-500';

/**
 * Table editor for a configuration's deploy parameters: the values the Deploy panel asks for
 * and hands to the build's `deploy.sh` as environment variables.
 */
export function DeployParametersEditor({ rows, onChange }: DeployParametersEditorProps) {
  const update = (index: number, patch: { name?: string; field?: Partial<DeploySchemaField> }) => {
    onChange(rows.map((row, i) => i !== index ? row : {
      name: patch.name !== undefined ? patch.name : row.name,
      field: patch.field ? { ...row.field, ...patch.field } : row.field,
    }));
  };
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const add = () => onChange([...rows, { name: '', field: { type: 'string' } }]);

  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-gray-500">No deploy parameters. The deploy script runs with the build's environment only.</p>}
      {rows.map((row, index) => (
        <div key={index} className="bg-gray-900/40 rounded p-3 space-y-2">
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-4">
              <label className="block text-xs text-gray-500 mb-0.5">Variable</label>
              <input type="text" value={row.name} onChange={e => update(index, { name: e.target.value.toUpperCase() })} placeholder="FRAMEWORK_VERSION" className={`${INPUT} font-mono`} />
            </div>
            <div className="col-span-3">
              <label className="block text-xs text-gray-500 mb-0.5">Type</label>
              <select value={row.field.type} onChange={e => update(index, { field: { type: e.target.value as DeploySchemaField['type'] } })} className={INPUT}>
                <option value="string">string</option>
                <option value="boolean">boolean</option>
                <option value="select">select</option>
              </select>
            </div>
            <div className="col-span-4">
              <label className="block text-xs text-gray-500 mb-0.5">Label</label>
              <input type="text" value={row.field.label ?? ''} onChange={e => update(index, { field: { label: e.target.value } })} placeholder={row.name || 'Shown in the Deploy panel'} className={INPUT} />
            </div>
            <div className="col-span-1 flex items-end justify-end">
              <button type="button" onClick={() => remove(index)} className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded" title="Remove parameter">✕</button>
            </div>
          </div>
          <div className="grid grid-cols-12 gap-2">
            {row.field.type === 'select' && (
              <div className="col-span-5">
                <label className="block text-xs text-gray-500 mb-0.5">Options (comma-separated)</label>
                <input type="text" value={(row.field.options ?? []).join(', ')} onChange={e => update(index, { field: { options: e.target.value.split(',') } })} className={INPUT} />
              </div>
            )}
            {row.field.type === 'string' && (
              <div className="col-span-5">
                <label className="block text-xs text-gray-500 mb-0.5">Pattern (regex, optional)</label>
                <input type="text" value={row.field.pattern ?? ''} onChange={e => update(index, { field: { pattern: e.target.value } })} placeholder="^v\\d+\\.\\d+\\.\\d+$" className={`${INPUT} font-mono`} />
              </div>
            )}
            <div className={row.field.type === 'boolean' ? 'col-span-5' : 'col-span-3'}>
              <label className="block text-xs text-gray-500 mb-0.5">Default</label>
              {row.field.type === 'boolean' ? (
                <label className="flex items-center gap-2 py-1">
                  <input type="checkbox" checked={Boolean(row.field.default)} onChange={e => update(index, { field: { default: e.target.checked } })} className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500" />
                  <span className="text-sm text-gray-300">on by default</span>
                </label>
              ) : (
                <input type="text" value={row.field.default === undefined ? '' : String(row.field.default)} onChange={e => update(index, { field: { default: e.target.value } })} className={INPUT} />
              )}
            </div>
            {row.field.type !== 'boolean' && (
              <div className="col-span-2 flex items-end">
                <label className="flex items-center gap-2 py-1">
                  <input type="checkbox" checked={Boolean(row.field.required)} onChange={e => update(index, { field: { required: e.target.checked } })} className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-500" />
                  <span className="text-sm text-gray-300">required</span>
                </label>
              </div>
            )}
            <div className={row.field.type === 'boolean' ? 'col-span-7' : 'col-span-2'}>
              <label className="block text-xs text-gray-500 mb-0.5">Description</label>
              <input type="text" value={row.field.description ?? ''} onChange={e => update(index, { field: { description: e.target.value } })} className={INPUT} />
            </div>
          </div>
        </div>
      ))}
      <button type="button" onClick={add} className="text-xs text-blue-400 hover:text-blue-300">+ Add parameter</button>
    </div>
  );
}
