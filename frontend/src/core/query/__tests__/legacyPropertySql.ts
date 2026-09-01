/**
 * Convert the decorrelated IN form emitted for custom property conditions
 * back to the legacy correlated EXISTS form, for before/after equivalence and
 * benchmark comparisons in tests. Pre-fix this is an identity transform
 * because the compiler already emits the EXISTS form.
 */
export function toLegacyPropertySql(sql: string, alias = 'n'): string {
  let out = sql;
  const leg = 'pv_leg';
  // Replacer functions avoid `$`-pattern interpretation in replacement strings
  // (`'$'` in the json_extract path would otherwise be mangled by replaceAll).
  // not_in wraps the whole IN clause in NOT (...), so it is converted whole
  // first (the legacy NOT EXISTS form has one fewer closing paren).
  const notInRe = new RegExp(
    `NOT \\(${alias}\\.id IN \\(SELECT node_id FROM property_value WHERE property_schema_id = \\? AND json_extract\\(property_value\\.value, '\\$'\\) IN \\(([^)]*)\\)\\)\\)`,
    'g'
  );
  out = out.replace(
    notInRe,
    (_match, list: string) =>
      `NOT EXISTS (SELECT 1 FROM property_value ${leg} WHERE ${leg}.node_id = ${alias}.id AND ${leg}.property_schema_id = ? AND json_extract(${leg}.value, '$') IN (${list}))`
  );
  out = out.replaceAll(
    `${alias}.id NOT IN (SELECT node_id FROM property_value WHERE property_schema_id = ?)`,
    () => `NOT EXISTS (SELECT 1 FROM property_value ${leg} WHERE ${leg}.node_id = ${alias}.id AND ${leg}.property_schema_id = ?)`
  );
  out = out.replaceAll(
    `${alias}.id IN (SELECT node_id FROM property_value WHERE property_schema_id = ? AND `,
    () => `EXISTS (SELECT 1 FROM property_value ${leg} WHERE ${leg}.node_id = ${alias}.id AND ${leg}.property_schema_id = ? AND `
  );
  out = out.replaceAll(
    `${alias}.id IN (SELECT node_id FROM property_value WHERE property_schema_id = ?)`,
    () => `EXISTS (SELECT 1 FROM property_value ${leg} WHERE ${leg}.node_id = ${alias}.id AND ${leg}.property_schema_id = ?)`
  );
  out = out.replaceAll(`json_extract(property_value.value, '$')`, () => `json_extract(${leg}.value, '$')`);
  return out;
}
