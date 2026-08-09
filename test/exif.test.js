// First real test: build a JPEG with known EXIF GPS and prove we read it back.
// Susheel's iPhone originals should carry coordinates; nothing on this machine does,
// so without this the GPS path would ship untested.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const exif = require('../server/exif.js');

function buildJpegWithGps({ lat = [12, 58, 15], latRef = 'N', lon = [77, 35, 30], lonRef = 'E',
                            make = 'Apple', model = 'iPhone 8' } = {}) {
  const bufs = [], rat = (n, d) => { const b = Buffer.alloc(8); b.writeUInt32BE(n, 0); b.writeUInt32BE(d, 4); return b; };
  // TIFF block, big-endian
  const tiff = [];
  const push = b => { tiff.push(b); return b.length; };
  const header = Buffer.alloc(8); header.write('MM', 0, 'latin1'); header.writeUInt16BE(42, 2); header.writeUInt32BE(8, 4);
  // Layout: header(8) | IFD0 | data area
  const entry = (tag, type, count, valueOrOffset) => {
    const e = Buffer.alloc(12); e.writeUInt16BE(tag, 0); e.writeUInt16BE(type, 2); e.writeUInt32BE(count, 4);
    if (Buffer.isBuffer(valueOrOffset)) valueOrOffset.copy(e, 8); else e.writeUInt32BE(valueOrOffset, 8);
    return e;
  };
  const ifd0Count = 3;                                   // Make, Model, GPS pointer
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  let dataOff = 8 + ifd0Size;
  const makeBuf = Buffer.from(make + '\0', 'latin1'), modelBuf = Buffer.from(model + '\0', 'latin1');
  const makeOff = dataOff; dataOff += makeBuf.length;
  const modelOff = dataOff; dataOff += modelBuf.length;
  const gpsIfdOff = dataOff;
  const gpsCount = 4;
  const gpsIfdSize = 2 + gpsCount * 12 + 4;
  let gpsDataOff = gpsIfdOff + gpsIfdSize;
  const latBuf = Buffer.concat(lat.map(v => rat(Math.round(v * 100), 100)));
  const lonBuf = Buffer.concat(lon.map(v => rat(Math.round(v * 100), 100)));
  const latOff = gpsDataOff; gpsDataOff += latBuf.length;
  const lonOff = gpsDataOff; gpsDataOff += lonBuf.length;

  const ifd0 = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(ifd0Count, 0); return b; })(),
    entry(0x010f, 2, makeBuf.length, makeOff),
    entry(0x0110, 2, modelBuf.length, modelOff),
    entry(0x8825, 4, 1, gpsIfdOff),
    Buffer.alloc(4),
  ]);
  const refBuf = s => { const b = Buffer.alloc(4); b.write(s + '\0', 0, 'latin1'); return b; };
  const gpsIfd = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(gpsCount, 0); return b; })(),
    entry(1, 2, 2, refBuf(latRef)),
    entry(2, 5, 3, latOff),
    entry(3, 2, 2, refBuf(lonRef)),
    entry(4, 5, 3, lonOff),
    Buffer.alloc(4),
  ]);
  const tiffBlock = Buffer.concat([header, ifd0, makeBuf, modelBuf, gpsIfd, latBuf, lonBuf]);
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBlock]);
  const app1Len = Buffer.alloc(2); app1Len.writeUInt16BE(app1Payload.length + 2, 0);
  // Minimal SOF0 so dimensions parse too
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x00, 0x06, 0x00, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1]), app1Len, app1Payload, sof, Buffer.from([0xff, 0xd9])]);
}

const tmp = path.join(os.tmpdir(), 'yellide-exif-test.jpg');
fs.writeFileSync(tmp, buildJpegWithGps());
const r = exif.extractImage(tmp);
fs.unlinkSync(tmp);

console.log('parsed:', JSON.stringify({ camera: r.camera, gps: r.gps, lat: r.gps_lat, lon: r.gps_lon, w: r.width, h: r.height }));
assert.strictEqual(r.camera, 'Apple iPhone 8', 'camera');
assert.ok(r.gps_lat > 12.97 && r.gps_lat < 12.98, 'latitude ~12.9708, got ' + r.gps_lat);
assert.ok(r.gps_lon > 77.59 && r.gps_lon < 77.60, 'longitude ~77.5917, got ' + r.gps_lon);
assert.strictEqual(r.width, 1536); assert.strictEqual(r.height, 1024);

// Southern/western hemisphere must come back negative
fs.writeFileSync(tmp, buildJpegWithGps({ latRef: 'S', lonRef: 'W' }));
const s = exif.extractImage(tmp); fs.unlinkSync(tmp);
assert.ok(s.gps_lat < 0 && s.gps_lon < 0, 'S/W must be negative, got ' + s.gps_lat + ',' + s.gps_lon);

console.log('PASS — GPS, hemisphere signs, camera and dimensions all verified');
