// Test helper: read a stored ZIP (the format the inspector writes), checking
// each entry's CRC and the central directory's entry count.
const assert = require('node:assert/strict');

function readZipBuffers(buffer) {
  const files = new Map();
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xFFFFFFFF; for (const b of bytes) c = table[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18), nameLength = buffer.readUInt16LE(at + 26), extra = buffer.readUInt16LE(at + 28);
    const name = buffer.toString('utf8', at + 30, at + 30 + nameLength);
    const data = buffer.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size);
    assert.equal(crc(data), buffer.readUInt32LE(at + 14), `CRC of ${name}`);
    files.set(name, Buffer.from(data));
    at += 30 + nameLength + extra + size;
  }
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50);
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.size);
  return files;
}
function readZip(buffer) {
  return new Map([...readZipBuffers(buffer)].map(([name, data]) => [name, data.toString('utf8')]));
}
module.exports = { readZip, readZipBuffers };
