/**
 * Pure JavaScript QR Code Generator (ISO/IEC 18004 compliant subset).
 * Zero external dependencies, pure vector SVG output.
 */

// GF(256) Galois Field tables with primitive polynomial 0x11D (285)
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x >= 256) {
      x ^= 0x11d;
    }
  }
  LOG_TABLE[0] = 0;
})();

function gfMultiply(x, y) {
  if (x === 0 || y === 0) return 0;
  return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
}

function getRsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const factor = [1, EXP_TABLE[i]];
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMultiply(poly[j], factor[0]);
      next[j + 1] ^= gfMultiply(poly[j], factor[1]);
    }
    poly = next;
  }
  return poly;
}

function calculateRsRemainder(data, degree) {
  const gen = getRsGeneratorPoly(degree);
  const result = new Array(degree).fill(0);

  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    if (factor !== 0) {
      for (let i = 0; i < degree; i++) {
        result[i] ^= gfMultiply(gen[i + 1], factor);
      }
    }
  }
  return result;
}

// Version table for Error Correction Level M (15% error correction)
// [totalCodewords, ecCodewordsPerBlock, numBlocksGroup1, dataCodewordsGroup1, numBlocksGroup2, dataCodewordsGroup2]
const VERSION_TABLE_M = [
  null, // 0 index unused
  [26, 10, 1, 16, 0, 0],       // V1: 21x21, 14 bytes byte mode
  [44, 16, 1, 28, 0, 0],       // V2: 25x25, 26 bytes byte mode
  [70, 26, 1, 44, 0, 0],       // V3: 29x29, 42 bytes byte mode
  [100, 18, 2, 32, 0, 0],      // V4: 33x33, 62 bytes byte mode
  [134, 24, 2, 43, 0, 0],      // V5: 37x37, 84 bytes byte mode
  [172, 16, 4, 27, 0, 0],      // V6: 41x41, 106 bytes byte mode
  [196, 18, 4, 31, 0, 0],      // V7: 45x45, 122 bytes byte mode
  [242, 22, 2, 38, 2, 39],     // V8: 49x49, 152 bytes byte mode
  [292, 22, 3, 36, 2, 37],     // V9: 53x53, 180 bytes byte mode
  [346, 26, 4, 43, 1, 44]      // V10: 57x57, 213 bytes byte mode
];

// Alignment pattern centers per version
const ALIGNMENT_PATTERN_POS = [
  [],
  [],                          // V1
  [6, 18],                     // V2
  [6, 22],                     // V3
  [6, 26],                     // V4
  [6, 30],                     // V5
  [6, 34],                     // V6
  [6, 22, 38],                 // V7
  [6, 24, 42],                 // V8
  [6, 26, 46],                 // V9
  [6, 28, 50]                  // V10
];

/**
 * Determines the minimum required QR version for a given byte length at Level M.
 */
function getBestVersion(dataLength) {
  for (let v = 1; v <= 10; v++) {
    const entry = VERSION_TABLE_M[v];
    const totalData = (entry[2] * entry[3]) + (entry[4] * entry[5]);
    // Byte mode overhead: 4 bits mode + 8 bits char count (for V1-9) = 1.5 bytes -> max capacity is totalData - 2
    if (dataLength <= totalData - 2) {
      return v;
    }
  }
  throw new Error(`Data too large for QR generator (max 213 bytes, received ${dataLength})`);
}

/**
 * Encodes text into QR BitStream with Byte Mode & Error Correction.
 */
function encodeQrData(text, version) {
  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(text);
  const entry = VERSION_TABLE_M[version];
  const totalDataCodewords = (entry[2] * entry[3]) + (entry[4] * entry[5]);

  const bits = [];
  function pushBits(val, len) {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  }

  // 1. Mode indicator: 0100 for Byte mode
  pushBits(0b0100, 4);

  // 2. Character count indicator (8 bits for V1-V9, 16 bits for V10)
  pushBits(rawBytes.length, version <= 9 ? 8 : 16);

  // 3. Data bytes
  for (const b of rawBytes) {
    pushBits(b, 8);
  }

  // 4. Terminator: up to 4 zero bits
  const capacityBits = totalDataCodewords * 8;
  const termLen = Math.min(4, capacityBits - bits.length);
  pushBits(0, termLen);

  // 5. Pad to multiple of 8
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  // Convert to bytes
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[i + b];
    }
    dataBytes.push(byte);
  }

  // 6. Pad bytes 0xEC and 0x11
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (dataBytes.length < totalDataCodewords) {
    dataBytes.push(padBytes[padIdx % 2]);
    padIdx++;
  }

  // 7. Split into blocks and compute Reed-Solomon EC
  const ecPerBlock = entry[1];
  const numBlocksG1 = entry[2];
  const dataLenG1 = entry[3];
  const numBlocksG2 = entry[4];
  const dataLenG2 = entry[5];

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let b = 0; b < numBlocksG1; b++) {
    const block = dataBytes.slice(offset, offset + dataLenG1);
    offset += dataLenG1;
    dataBlocks.push(block);
    ecBlocks.push(calculateRsRemainder(block, ecPerBlock));
  }
  for (let b = 0; b < numBlocksG2; b++) {
    const block = dataBytes.slice(offset, offset + dataLenG2);
    offset += dataLenG2;
    dataBlocks.push(block);
    ecBlocks.push(calculateRsRemainder(block, ecPerBlock));
  }

  // 8. Interleave data codewords
  const finalCodewords = [];
  const maxDataLen = Math.max(dataLenG1, dataLenG2);
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) finalCodewords.push(block[i]);
    }
  }

  // 9. Interleave EC codewords
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) {
      if (i < block.length) finalCodewords.push(block[i]);
    }
  }

  return finalCodewords;
}

/**
 * Creates empty module matrix and reserved mask.
 */
function createMatrix(size) {
  const matrix = Array.from({ length: size }, () => new Uint8Array(size));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));
  return { matrix, reserved, size };
}

function setFinderPattern(matrix, reserved, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const nr = row + r;
      const nc = col + c;
      if (nr < 0 || nr >= matrix.length || nc < 0 || nc >= matrix.length) continue;
      reserved[nr][nc] = 1;
      if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
        if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
          matrix[nr][nc] = 1;
        } else {
          matrix[nr][nc] = 0;
        }
      } else {
        matrix[nr][nc] = 0;
      }
    }
  }
}

function setAlignmentPattern(matrix, reserved, row, col) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const nr = row + r;
      const nc = col + c;
      reserved[nr][nc] = 1;
      if (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) {
        matrix[nr][nc] = 1;
      } else {
        matrix[nr][nc] = 0;
      }
    }
  }
}

/**
 * Builds the complete QR code matrix with masking.
 */
function buildQrMatrix(text) {
  const encoder = new TextEncoder();
  const rawBytes = encoder.encode(text);
  const version = getBestVersion(rawBytes.length);
  const size = 17 + 4 * version;
  const { matrix, reserved } = createMatrix(size);

  // 1. Finder patterns
  setFinderPattern(matrix, reserved, 0, 0);
  setFinderPattern(matrix, reserved, 0, size - 7);
  setFinderPattern(matrix, reserved, size - 7, 0);

  // 2. Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const val = (i % 2 === 0) ? 1 : 0;
    if (!reserved[6][i]) {
      matrix[6][i] = val;
      reserved[6][i] = 1;
    }
    if (!reserved[i][6]) {
      matrix[i][6] = val;
      reserved[i][6] = 1;
    }
  }

  // 3. Dark module at (4 * version + 9, 8)
  matrix[4 * version + 9][8] = 1;
  reserved[4 * version + 9][8] = 1;

  // 4. Alignment patterns for Version >= 2
  const alignPos = ALIGNMENT_PATTERN_POS[version];
  for (let r = 0; r < alignPos.length; r++) {
    for (let c = 0; c < alignPos.length; c++) {
      const ar = alignPos[r];
      const ac = alignPos[c];
      // Skip alignment patterns overlapping finder patterns
      if (
        (ar === 6 && ac === 6) ||
        (ar === 6 && ac === alignPos[alignPos.length - 1] && ac > size - 10) ||
        (ar === alignPos[alignPos.length - 1] && ac === 6 && ar > size - 10)
      ) {
        continue;
      }
      setAlignmentPattern(matrix, reserved, ar, ac);
    }
  }

  // 5. Reserve format info areas around finder patterns
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }

  // 6. Encode data codewords
  const codewords = encodeQrData(text, version);
  const dataBits = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i--) {
      dataBits.push((byte >>> i) & 1);
    }
  }

  // 7. Place data bits in zigzag upward/downward pattern
  let bitIdx = 0;
  let upwards = true;

  for (let rightCol = size - 1; rightCol > 0; rightCol -= 2) {
    if (rightCol === 6) rightCol--; // Skip vertical timing pattern column

    const rowRange = upwards
      ? Array.from({ length: size }, (_, i) => size - 1 - i)
      : Array.from({ length: size }, (_, i) => i);

    for (const r of rowRange) {
      for (let c = 0; c < 2; c++) {
        const col = rightCol - c;
        if (!reserved[r][col]) {
          const bit = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
          matrix[r][col] = bit;
        }
      }
    }
    upwards = !upwards;
  }

  // 8. Mask pattern (Mask 0: (row + col) % 2 === 0)
  // Mask 0 is standard and effective for structured text/URLs
  const maskPattern = (r, c) => ((r + c) % 2 === 0);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && maskPattern(r, c)) {
        matrix[r][c] ^= 1;
      }
    }
  }

  // 9. Format Info Bits for ECC Level M (00) + Mask 0 (000)
  // Format bit string = 00000 -> with BCH error correction and XOR mask:
  // Precomputed 15-bit format info for (Level M, Mask 0): 0b101010000010010
  const formatInfo = 0b101010000010010;

  // Top-left finder format bits
  for (let i = 0; i <= 5; i++) matrix[8][i] = (formatInfo >>> (14 - i)) & 1;
  matrix[8][7] = (formatInfo >>> 8) & 1;
  matrix[8][8] = (formatInfo >>> 7) & 1;
  matrix[7][8] = (formatInfo >>> 6) & 1;
  for (let i = 0; i <= 5; i++) matrix[5 - i][8] = (formatInfo >>> (5 - i)) & 1;

  // Second copy of format bits around remaining finders
  for (let i = 0; i <= 7; i++) matrix[8][size - 1 - i] = (formatInfo >>> i) & 1;
  for (let i = 0; i <= 6; i++) matrix[size - 7 + i][8] = (formatInfo >>> (i + 8)) & 1;

  return { matrix, size };
}

/**
 * Generates an SVG string representation of a QR code.
 *
 * @param {string} text
 * @param {{ size?: number }} [options]
 * @returns {string} SVG XML markup
 */
export function generateQrSvg(text, { size = 200 } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('Text to encode must be a non-empty string');
  }

  const { matrix, size: modCount } = buildQrMatrix(text.trim());
  const margin = 4; // Standard 4-module quiet zone
  const totalGrid = modCount + margin * 2;

  let pathData = '';
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (matrix[r][c] === 1) {
        pathData += `M${c + margin},${r + margin}h1v1h-1z `;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalGrid} ${totalGrid}" width="${size}" height="${size}" shape-rendering="crispEdges" aria-label="QR Code">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <path d="${pathData.trim()}" fill="#111827"/>
</svg>`;
}
