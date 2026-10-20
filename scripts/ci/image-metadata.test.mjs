import assert from 'node:assert/strict';
import test from 'node:test';

import { imageMetadataFailures } from './image-metadata.mjs';

test('JPEGのscan後に追加されたAPP metadataと終端後のデータを拒否する', () => {
  const minimal = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  assert.deepEqual(imageMetadataFailures('sample.jpg', minimal), []);
  const injectedApp = Buffer.concat([minimal.subarray(0, 6), Buffer.from([0xff, 0xe1, 0x00, 0x02]), minimal.subarray(6)]);
  assert.match(imageMetadataFailures('sample.jpg', injectedApp).join(','), /EXIF/);
  assert.match(imageMetadataFailures('sample.jpg', Buffer.concat([minimal, Buffer.from('private')])).join(','), /終端/);
});

test('PNGのIEND以降に追加されたデータを拒否する', () => {
  const minimal = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0]);
  assert.deepEqual(imageMetadataFailures('sample.png', minimal), []);
  assert.match(imageMetadataFailures('sample.png', Buffer.concat([minimal, Buffer.from('private')])).join(','), /終端/);
});
