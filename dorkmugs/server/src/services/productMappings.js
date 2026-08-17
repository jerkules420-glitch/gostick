const fs = require('fs');
const path = require('path');

const mappingPath = path.resolve(__dirname, '../../data/printify-products.json');
let mappings;

function load() {
  if (mappings) return mappings;
  try {
    mappings = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  } catch {
    mappings = {};
  }
  return mappings;
}

function get(slug) {
  return load()[slug] || null;
}

function all() {
  return { ...load() };
}

function set(slug, value) {
  const current = load();
  current[slug] = { ...(current[slug] || {}), ...value, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
  const temporary = `${mappingPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, mappingPath);
  return current[slug];
}

module.exports = { get, all, set, mappingPath };