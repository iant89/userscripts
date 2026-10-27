// Regenerate the self-contained userscript's Font Awesome Free SVG path data.
const fs = require('node:fs');
const path = require('node:path');
const solid = require('@fortawesome/free-solid-svg-icons');
const { version } = require('@fortawesome/free-solid-svg-icons/package.json');

const icons = {
  search: 'faMagnifyingGlass',
  minus: 'faMinus',
  close: 'faXmark',
  code: 'faCode',
  terminal: 'faTerminal',
  'file-code': 'faFileCode',
  database: 'faDatabase',
  'expand-tree': 'faAnglesDown',
  pick: 'faCrosshairs',
  eye: 'faEye',
  'eye-slash': 'faEyeSlash',
  trash: 'faTrashCan',
  plus: 'faPlus',
  refresh: 'faRotateRight',
  play: 'faPlay',
  copy: 'faCopy',
  'file-lines': 'faFileLines',
  broom: 'faBroom',
  down: 'faArrowDown',
  up: 'faArrowUp',
  'chevron-down': 'faChevronDown',
  'chevron-right': 'faChevronRight',
  circle: 'faCircle',
  undo: 'faRotateLeft',
};

const scriptPath = path.join(__dirname, '..', 'Web Inspector.user.js');
const start = '  // BEGIN GENERATED FONT AWESOME DATA';
const end = '  // END GENERATED FONT AWESOME DATA';
const source = fs.readFileSync(scriptPath, 'utf8');
const startIndex = source.indexOf(start), endIndex = source.indexOf(end);
if (startIndex < 0 || endIndex < startIndex) throw new Error('Font Awesome data markers are missing.');
const lines = Object.entries(icons).map(([name, exportName]) => {
  const definition = solid[exportName];
  if (!definition) throw new Error(`Font Awesome icon not found: ${exportName}`);
  const [width, height, , , svgPath] = definition.icon;
  if (typeof svgPath !== 'string') throw new Error(`${exportName} is not a single-path solid icon.`);
  return `    ${JSON.stringify(name)}: ${JSON.stringify([width, height, svgPath])},`;
});
const block = `${start}\n  /*\n   * Font Awesome Free ${version} by Fonticons, Inc. (https://fontawesome.com).\n   * Icons are licensed under CC BY 4.0: https://creativecommons.org/licenses/by/4.0/\n   * The paths are unmodified and embedded as inline SVG for this userscript.\n   */\n  const FA_ICONS = {\n${lines.join('\n')}\n  };\n${end}`;
const updated = source.slice(0, startIndex) + block + source.slice(endIndex + end.length);
if (process.argv.includes('--check')) {
  if (updated !== source) {
    console.error('Font Awesome data is out of date; run npm run update:icons.');
    process.exitCode = 1;
  }
} else if (updated !== source) {
  fs.writeFileSync(scriptPath, updated);
  console.log(`Updated ${lines.length} Font Awesome icons in the userscript.`);
}
