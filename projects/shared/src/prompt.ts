/**
 * Server-only entry (`@repopilot/shared/prompt`): turns the catalog into text
 * for the system prompt. Kept out of the main entry because JSON Schema
 * generation is large and the browser never needs it.
 */
import * as z from 'zod';
import { catalog, CatalogEntry, componentNames } from './catalog';

/**
 * The catalog as text for the system prompt: allowed names, when to use each,
 * and the JSON Schema of their props. Generated from the same schemas the
 * validator uses, so the prompt and the validator cannot drift apart.
 */
export function buildCatalogPromptDoc(): string {
  const entries = componentNames
    .filter((name) => catalog[name].group !== 'safety')
    .map((name) => {
      const entry: CatalogEntry = catalog[name];
      const schema = JSON.stringify(z.toJSONSchema(entry.props, { io: 'input' }));
      const events = entry.events.length ? ` Events: ${entry.events.join(', ')}.` : '';
      return `### ${name}\n${entry.description}${events}\nProps JSON Schema: ${schema}`;
    });

  return [
    'You answer with UI nodes shaped { "component": <name>, "props": <object> }.',
    'Use only the components below. Grid and Section nest other nodes in "children".',
    'Never output HTML, Markdown tables or scripts inside props.',
    '',
    ...entries,
  ].join('\n');
}
